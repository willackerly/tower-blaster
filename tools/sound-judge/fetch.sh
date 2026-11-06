#!/bin/sh
# YAMNet's weights and class map (Apache 2.0, Google), and the ESC-50 reference clips the judge is
# calibrated on (CC BY-NC 3.0, Piczak 2015: used here only to check the judge, never shipped).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/yamnet" "$here/ref"
curl -sSfo "$here/yamnet/yamnet.h5" https://storage.googleapis.com/audioset/yamnet.h5
curl -sSfo "$here/yamnet/yamnet_class_map.csv" https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv
curl -sSfo "$here/ref/esc50.csv" https://raw.githubusercontent.com/karolpiczak/ESC-50/master/meta/esc50.csv
grep -E ',(door_wood_knock|glass_breaking|fireworks|footsteps|can_opening|mouse_click|clock_alarm|church_bells),' "$here/ref/esc50.csv" | awk -F, '$2 <= 2' |
  while IFS=, read -r f fold t cat rest; do curl -sSfo "$here/ref/$cat--$f" "https://raw.githubusercontent.com/karolpiczak/ESC-50/master/audio/$f"; done
echo "fetched: $(ls "$here/ref" | grep -c wav) reference clips"
