// Microphone capture for the analysis: hands every input sample to the page in blocks of 1024,
// with the context frame number of the block's end. (No processing here: the page analyses it.)
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          // eslint-disable-next-line no-undef
          this.port.postMessage({ samples: this.buf, frame: currentFrame + i + 1 }, [this.buf.buffer]);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
// eslint-disable-next-line no-undef
registerProcessor('capture', Capture);
