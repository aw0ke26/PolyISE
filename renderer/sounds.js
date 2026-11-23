// Tiny synthesized UI sounds (no audio files needed). Toggle with Sounds.enabled.
const Sounds = (() => {
  let ctx = null;
  const api = { enabled: true };
  const ac = () => (ctx = ctx || new AudioContext());

  function blip(freq, dur, type = 'sine', gain = 0.08, slideTo = null) {
    if (!api.enabled) return;
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur + 0.02);
  }

  function noise(dur, gain = 0.06, hp = 1200) {
    if (!api.enabled) return;
    const c = ac();
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource();
    const f = c.createBiquadFilter();
    const g = c.createGain();
    f.type = 'highpass'; f.frequency.value = hp;
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
  }

  api.click = () => blip(1400, 0.035, 'square', 0.03);
  api.tick = () => blip(1900, 0.03, 'sine', 0.07);                  // pick up
  api.clack = () => { noise(0.05, 0.08, 900); blip(320, 0.08, 'triangle', 0.1); }; // drop
  api.whoosh = () => blip(500, 0.18, 'sine', 0.05, 1600);           // mode switch
  api.error = () => blip(220, 0.18, 'square', 0.04, 150);
  api.success = () => { blip(880, 0.07, 'sine', 0.06); setTimeout(() => blip(1320, 0.09, 'sine', 0.06), 70); };
  return api;
})();
