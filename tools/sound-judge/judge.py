# The realism judge: how synthetic does a clip sound? YAMNet (Google's AudioSet classifier, 521 classes;
# only its weights are downloaded, by fetch.sh) re-implemented here in numpy, over each clip's loud
# windows. Per clip: grouped class scores (real impact events, electronic, musical instrument), their
# real share real / (real + electronic + instrument), the top classes, and two signal figures
# (tonality: the share of 100 Hz-10 kHz energy in narrow spectral peaks; the spectral centroid).
# Calibration (docs/sound.md, Realism): ESC-50's real recordings score a mean real share of 0.68-0.98
# (door knock ... footsteps), its alarm clocks 0.07 and church bells 0.00. Material shares (wood, glass,
# metal, mineral) from AudioSet's material labels: docs/sound.md, Material identity.
# usage: python3 -I judge.py out.json file.wav [file.wav ...]   (-I: never import from the clips' folders)
#        python3 -I judge.py --summary out.json                  (mean real share per tag: <level>-<tag>.wav)
import csv, json, os, sys
import h5py, numpy as np, soundfile as sf
from scipy.signal import medfilt, resample_poly, welch

HERE = os.path.dirname(os.path.abspath(__file__))
GROUPS = {
  'real': ['Smash, crash', 'Breaking', 'Thump, thud', 'Clatter', 'Knock', 'Tap', 'Wood', 'Crack', 'Bang', 'Explosion', 'Boom',
           'Rumble', 'Glass', 'Rattle', 'Clang', 'Crackle', 'Fireworks', 'Firecracker', 'Gunshot, gunfire', 'Shatter', 'Chink, clink', 'Slam',
           'Walk, footsteps', 'Door', 'Cupboard open or close', 'Drawer open or close', 'Dishes, pots, and pans', 'Cutlery, silverware', 'Thunder', 'Thunderstorm'],
  'electronic': ['Synthesizer', 'Sine wave', 'Beep, bleep', 'Electronic tuner', 'Electronic music', 'Video game music', 'Reversing beeps',
                 'Electronica', 'Theme music', 'Ringtone', 'Alarm', 'Buzzer', 'Busy signal', 'Dial tone', 'Telephone dialing, DTMF'],
  'instrument': ['Music', 'Musical instrument', 'Marimba, xylophone', 'Wood block', 'Bell', 'Chime', 'Ding', 'Cowbell', 'Tubular bells', 'Percussion',
                 'Glockenspiel', 'Vibraphone', 'Steelpan', 'Drum', 'Bass drum', 'Mallet percussion', 'Wind chime', 'Jingle bell', 'Drum kit', 'Snare drum', 'Timpani', 'Tabla'],
}
# What the impacts are made of, as far as AudioSet's labels say (it has no stone or plastic class:
# hard mineral debris shows as Crack, Clatter, Rattle, Crushing, Smash). A material's share is its
# group's sum over the four groups' total.
MATERIALS = {
  'wood': ['Wood', 'Wood block', 'Door', 'Knock', 'Splinter', 'Chopping (food)', 'Creak', 'Whack, thwack', 'Slam', 'Sliding door',
           'Walk, footsteps', 'Cupboard open or close', 'Drawer open or close'],
  'glass': ['Glass', 'Chink, clink', 'Shatter'],
  'metal': ['Clang', 'Ding', 'Ping', 'Coin (dropping)', 'Keys jangling', 'Jingle, tinkle', 'Dishes, pots, and pans', 'Cutlery, silverware'],
  'mineral': ['Crack', 'Clatter', 'Rattle', 'Crushing', 'Smash, crash', 'Breaking', 'Rumble'],
}
SR, WIN, HOP, NFFT, MELS, FMIN, FMAX, EPS = 16000, 400, 160, 512, 64, 125.0, 7500.0, 1e-4
LAYERS = [('c', 2, 32), ('s', 1, 64), ('s', 2, 128), ('s', 1, 128), ('s', 2, 256), ('s', 1, 256), ('s', 2, 512),
          ('s', 1, 512), ('s', 1, 512), ('s', 1, 512), ('s', 1, 512), ('s', 1, 512), ('s', 2, 1024), ('s', 1, 1024)]

def mel_matrix():
  # tf.signal.linear_to_mel_weight_matrix: HTK mel, DC row zero.
  hz2mel = lambda f: 1127.0 * np.log1p(f / 700.0)
  nb = NFFT // 2 + 1
  lin = hz2mel(np.linspace(0, SR / 2, nb)[1:])[:, None]
  edges = np.linspace(hz2mel(FMIN), hz2mel(FMAX), MELS + 2)
  lo, c, hi = edges[:-2], edges[1:-1], edges[2:]
  w = np.maximum(0, np.minimum((lin - lo) / (c - lo), (hi - lin) / (hi - c)))
  return np.vstack([np.zeros((1, MELS)), w])

def logmel(x):
  # Pad to a whole number of 0.96 s patches hopped 0.48 s (pad_waveform), framed STFT, periodic Hann.
  mn = int((0.96 + 0.025 - 0.010) * SR); n = max(len(x), mn); hop = int(0.48 * SR)
  n = mn + hop * int(np.ceil((n - mn) / hop)); x = np.pad(x, (0, n - len(x)))
  nf = 1 + (len(x) - WIN) // HOP
  idx = np.arange(WIN)[None, :] + HOP * np.arange(nf)[:, None]
  win = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(WIN) / WIN)
  mag = np.abs(np.fft.rfft(x[idx] * win, NFFT))
  return np.log(mag @ mel_matrix() + 0.001)

def same_pad(a, k, s):
  # TF 'same' padding on axes 0, 1 of (H, W, C).
  out = []
  for ax in (0, 1):
    n = a.shape[ax]; o = -(-n // s); t = max((o - 1) * s + k - n, 0); out.append((t // 2, t - t // 2))
  return np.pad(a, (out[0], out[1], (0, 0)))

class Yamnet:
  def __init__(self):
    f = h5py.File(os.path.join(HERE, 'yamnet', 'yamnet.h5'), 'r')
    g = lambda p: np.array(f[p])
    self.L = []
    for i, (kind, s, ch) in enumerate(LAYERS, 1):
      n = f'layer{i}'
      bn = lambda p: (g(f'{n}/{p}/bn/{n}/{p}/bn/moving_mean:0'), g(f'{n}/{p}/bn/{n}/{p}/bn/moving_variance:0'), g(f'{n}/{p}/bn/{n}/{p}/bn/beta:0'))
      if kind == 'c': self.L.append(('c', s, g(f'{n}/conv/{n}/conv/kernel:0'), bn('conv')))
      else: self.L.append(('s', s, g(f'{n}/depthwise_conv/{n}/depthwise_conv/depthwise_kernel:0')[:, :, :, 0], bn('depthwise_conv'),
                           g(f'{n}/pointwise_conv/{n}/pointwise_conv/kernel:0')[0, 0], bn('pointwise_conv')))
    self.W, self.b = g('logits/logits/kernel:0'), g('logits/logits/bias:0')
    with open(os.path.join(HERE, 'yamnet', 'yamnet_class_map.csv')) as fh:
      r = csv.reader(fh); next(r); self.names = [row[2] for row in r]

  @staticmethod
  def _bn(x, p):
    m, v, b = p
    return np.maximum(0, (x - m) / np.sqrt(v + EPS) + b)

  def patch(self, p):
    a = p[:, :, None].astype(np.float64)
    for layer in self.L:
      s = layer[1]
      if layer[0] == 'c':
        k = layer[2]; ap = same_pad(a, 3, s); H, W = -(-a.shape[0] // s), -(-a.shape[1] // s)
        y = np.zeros((H, W, k.shape[3]))
        for i in range(3):
          for j in range(3): y += ap[i:i + s * H:s, j:j + s * W:s, :] @ k[i, j]
        a = self._bn(y, layer[3])
      else:
        dk, bn1, pk, bn2 = layer[2:]
        ap = same_pad(a, 3, s); H, W = -(-a.shape[0] // s), -(-a.shape[1] // s)
        y = np.zeros((H, W, a.shape[2]))
        for i in range(3):
          for j in range(3): y += ap[i:i + s * H:s, j:j + s * W:s, :] * dk[i, j]
        a = self._bn(self._bn(y, bn1) @ pk, bn2)
    e = a.mean(axis=(0, 1))
    return 1 / (1 + np.exp(-(e @ self.W + self.b))), e

  def __call__(self, x):
    lm = logmel(x)
    starts = range(0, lm.shape[0] - 96 + 1, 48)
    out = [self.patch(lm[t:t + 96]) for t in starts]
    return np.array([o[0] for o in out]), np.array([o[1] for o in out])

def load(f):
  x, sr = sf.read(f, dtype='float64')
  if x.ndim > 1: x = x.mean(axis=1)
  if sr != SR: x = resample_poly(x, SR, sr)
  return x / max(1e-9, np.abs(x).max()) * 0.5  # level-free: the judge hears the timbre, not the gain

def score(model, x):
  scores, emb = model(x)
  hop, win = int(0.48 * SR), int(0.96 * SR)
  e = np.array([np.mean(x[i * hop:i * hop + win] ** 2) + 1e-12 for i in range(scores.shape[0])])
  keep = e > e.max() * 1e-3  # windows within 30 dB of the loudest
  return scores[keep].mean(axis=0), emb[keep].mean(axis=0), int(keep.sum())

def signal_figures(f):
  x, sr = sf.read(f, dtype='float64')
  if x.ndim > 1: x = x.mean(axis=1)
  fr, p = welch(x, sr, nperseg=8192)
  m = (fr > 100) & (fr < 10000)
  floor = medfilt(p, 31)
  return {'tonal': float(p[m & (p > 4 * floor)].sum() / max(1e-30, p[m].sum())), 'centroid': float((fr * p).sum() / max(1e-30, p.sum()))}

def materials(s, mix):
  raw = {g: float(s[ix].sum()) for g, ix in mix.items()}
  tot = max(1e-9, sum(raw.values()))
  return {g: round(v / tot, 3) for g, v in raw.items()}

def share(v):
  return v['real'] / max(1e-9, v['real'] + v['electronic'] + v['instrument'])

def summary(path):
  import collections
  j = json.load(open(path)); agg = collections.defaultdict(list)
  def group(f):  # ref/<category>--<clip>.wav by category, <scene>-<variant>.wav by variant
    n = os.path.basename(f)[:-4]
    return n.split('--')[0] if '--' in n else n.split('-', 1)[-1]
  for f, v in j.items(): agg[group(f)].append(v)
  for k, vs in sorted(agg.items(), key=lambda kv: -np.mean([share(v) for v in kv[1]])):
    print(f"{k:28s} real share {np.mean([share(v) for v in vs]):.2f}  real {np.mean([v['real'] for v in vs]):.2f} instr {np.mean([v['instrument'] for v in vs]):.2f} "
          f"elec {np.mean([v['electronic'] for v in vs]):.2f}  tonal {np.mean([v['tonal'] for v in vs]):.2f}  ({len(vs)} clips)")

def main():
  if sys.argv[1] == '--summary': return summary(sys.argv[2])
  out, files = sys.argv[1], sys.argv[2:]
  model = Yamnet()
  missing = [n for cls in (*GROUPS.values(), *MATERIALS.values()) for n in cls if n not in model.names]
  if missing: raise SystemExit(f'not YAMNet classes: {missing}')
  idx = {g: [i for i, n in enumerate(model.names) if n in cls] for g, cls in GROUPS.items()}
  mix = {g: [i for i, n in enumerate(model.names) if n in cls] for g, cls in MATERIALS.items()}
  res = {}
  for f in files:
    s, e, n = score(model, load(f))
    top = np.argsort(-s)[:6]
    res[f] = {g: float(s[ix].sum()) for g, ix in idx.items()} | {'top': [(model.names[i], round(float(s[i]), 3)) for i in top], 'frames': n, 'materials': materials(s, mix)} | signal_figures(f)
    v = res[f]
    print(f"{os.path.basename(f):44s} share {share(v):.2f} real {v['real']:.3f} elec {v['electronic']:.3f} instr {v['instrument']:.3f} tonal {v['tonal']:.2f}  {' '.join(f'{g[:2]} {x:.2f}' for g, x in v['materials'].items())}  {', '.join(f'{a} {b:.2f}' for a, b in v['top'][:4])}", flush=True)
  json.dump(res, open(out, 'w'))

if __name__ == '__main__':
  main()
