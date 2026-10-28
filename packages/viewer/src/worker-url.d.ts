// Vite's ?worker&url import: the URL of a module bundled to run on its own (sound.ts loads the audio worklet this way).
declare module '*?worker&url' {
  const url: string;
  export default url;
}
