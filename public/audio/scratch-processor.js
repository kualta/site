/**
 * Plays a decoded track at a signed, hand-driven rate.
 *
 * A media element cannot run backwards or below about a quarter speed, so while
 * the record is being turned the audio comes from here instead: a playhead that
 * moves through the samples at whatever rate the hand asks for, forwards or back.
 */
class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = null;
    this.length = 0;
    this.position = 0; // in samples
    this.rate = 0; // signed ratio, 1 = normal speed
    this.target = 0;
    this.reportIn = 0;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "load") {
        this.channels = message.channels;
        this.length = message.channels[0].length;
      } else if (message.type === "seek") {
        this.position = message.seconds * sampleRate;
      } else if (message.type === "rate") {
        this.target = message.rate;
      } else if (message.type === "unload") {
        this.channels = null;
        this.length = 0;
        this.rate = 0;
        this.target = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const frames = output[0].length;

    if (!this.channels || this.length < 2) {
      for (const channel of output) channel.fill(0);
      return true;
    }

    for (let frame = 0; frame < frames; frame++) {
      // ease toward the requested rate so hand jitter does not click
      this.rate += (this.target - this.rate) * 0.02;

      const position = this.position;
      // a record held still makes no sound; holding a sample would be a DC offset
      if (this.rate > -0.001 && this.rate < 0.001) {
        for (const channel of output) channel[frame] = 0;
        continue;
      }

      if (position < 0 || position >= this.length - 1) {
        for (const channel of output) channel[frame] = 0;
        this.position = Math.min(Math.max(position, 0), this.length - 1);
        continue;
      }

      const index = position | 0;
      const fraction = position - index;

      for (let c = 0; c < output.length; c++) {
        const source = this.channels[Math.min(c, this.channels.length - 1)];
        output[c][frame] = source[index] * (1 - fraction) + source[index + 1] * fraction;
      }

      this.position += this.rate;
    }

    // tell the page where the needle ended up, a few times per second
    this.reportIn -= frames;
    if (this.reportIn <= 0) {
      this.reportIn = sampleRate / 20;
      this.port.postMessage({ type: "position", seconds: this.position / sampleRate });
    }

    return true;
  }
}

registerProcessor("scratch-processor", ScratchProcessor);
