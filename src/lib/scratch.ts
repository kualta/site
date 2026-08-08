/**
 * Web Audio side of the turntable: decodes a track once, then plays it at a
 * hand-driven rate while the record is being turned. The <audio> element still
 * handles ordinary playback, so nothing is decoded until someone grabs a record.
 */
export class ScratchDeck {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  // the level can be set before the deck is built, so it is kept here too
  private level = 1;
  private ready: Promise<void> | null = null;
  private loadedSrc: string | null = null;
  private loading: Promise<boolean> | null = null;

  onPosition: ((seconds: number) => void) | null = null;

  get isLoaded() {
    return this.node !== null && this.loadedSrc !== null;
  }

  get loadedFor() {
    return this.loadedSrc;
  }

  private async setup() {
    if (this.ready) return this.ready;

    this.ready = (async () => {
      const context = new AudioContext();
      await context.audioWorklet.addModule("/audio/scratch-processor.js");
      const node = new AudioWorkletNode(context, "scratch-processor", { outputChannelCount: [2] });
      node.port.onmessage = (event) => {
        if (event.data?.type === "position") this.onPosition?.(event.data.seconds);
      };
      // the hand-driven side goes through the same fader as the element
      const gain = context.createGain();
      gain.gain.value = this.level;
      node.connect(gain);
      gain.connect(context.destination);
      this.context = context;
      this.node = node;
      this.gain = gain;
    })();

    return this.ready;
  }

  /** Fetch and decode a track so the next grab is instant. Safe to call repeatedly. */
  async load(src: string) {
    if (this.loadedSrc === src) return true;
    if (this.loading) await this.loading;
    if (this.loadedSrc === src) return true;

    this.loading = (async () => {
      try {
        await this.setup();
        const context = this.context;
        const node = this.node;
        if (!context || !node) return false;

        const response = await fetch(src);
        const encoded = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(encoded);

        const channels: Float32Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          // copy out so the samples can be transferred to the worklet thread
          const data = new Float32Array(buffer.length);
          buffer.copyFromChannel(data, c);
          channels.push(data);
        }

        node.port.postMessage(
          { type: "load", channels },
          channels.map((channel) => channel.buffer),
        );
        this.loadedSrc = src;
        return true;
      } catch {
        return false;
      } finally {
        this.loading = null;
      }
    })();

    return this.loading;
  }

  async resume() {
    await this.setup();
    if (this.context?.state === "suspended") await this.context.resume();
  }

  seek(seconds: number) {
    this.node?.port.postMessage({ type: "seek", seconds });
  }

  setRate(rate: number) {
    this.node?.port.postMessage({ type: "rate", rate });
  }

  setVolume(level: number) {
    this.level = level;
    // a step would click; a short ramp is how a fader actually moves
    if (this.gain && this.context) {
      this.gain.gain.setTargetAtTime(level, this.context.currentTime, 0.01);
    }
  }

  unload() {
    this.node?.port.postMessage({ type: "unload" });
    this.loadedSrc = null;
  }
}
