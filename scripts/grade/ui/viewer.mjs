// The preview: each frame of the proxy (the clip's own code values) through the clip's composed 3D LUT on the GPU.
// The frame is uploaded with the browser's colour conversion switched off, so the shader sees the same code values
// ffmpeg reads from the original.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uVideo;
uniform sampler3D uLut;
uniform float uSize;
uniform int uMode;
uniform float uSplit;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uVideo, vUv).rgb;
  vec3 g = texture(uLut, c * ((uSize - 1.0) / uSize) + 0.5 / uSize).rgb;
  bool before = uMode == 1 || (uMode == 2 && vUv.x < uSplit);
  outColor = vec4(before ? c : g, 1.0);
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("This browser has no WebGL2");
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = Object.fromEntries(["uVideo", "uLut", "uSize", "uMode", "uSplit"].map((n) => [n, gl.getUniformLocation(prog, n)]));
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.videoTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_3D, k, v);
    gl.uniform1i(this.u.uVideo, 0);
    gl.uniform1i(this.u.uLut, 1);
    this.mode = 0;
    this.split = 0.5;
    this.video = null;
    this.hasFrame = false;
    this.setLut(2, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]));
  }

  setLut(size, data) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    this.lutSize = size;
    this.draw();
  }

  setMode(mode, split = this.split) {
    this.mode = mode;
    this.split = split;
    this.draw();
  }

  /** Follow a <video>: upload and draw each new frame. */
  attach(video) {
    this.video = video;
    this.hasFrame = false;
    const frame = () => {
      if (this.video !== video) return;
      this.upload();
      this.draw();
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
    const redraw = () => {
      if (this.video !== video) return;
      this.upload();
      this.draw();
    };
    for (const ev of ["loadeddata", "seeked", "playing"]) video.addEventListener(ev, redraw);
    if (!video.requestVideoFrameCallback) {
      const tick = () => {
        if (this.video !== video) return;
        if (!video.paused) redraw();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }

  /** Decode one frame of `video` through the same upload path and return its pixels, top row first (RGBA). */
  measure(video) {
    const { gl } = this;
    const keep = this.video;
    this.video = video;
    this.upload();
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.uniform1f(this.u.uSize, this.lutSize);
    gl.uniform1i(this.u.uMode, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const top = new Uint8Array(px.length);
    for (let y = 0; y < h; y++) top.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    this.video = keep;
    this.hasFrame = false;
    return { width: w, height: h, px: top };
  }

  upload() {
    const { gl, video } = this;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    if (this.canvas.width !== video.videoWidth || this.canvas.height !== video.videoHeight) {
      this.canvas.width = video.videoWidth;
      this.canvas.height = video.videoHeight;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    this.hasFrame = true;
  }

  draw() {
    const gl = this.gl;
    if (!this.hasFrame) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uSize, this.lutSize);
    gl.uniform1i(this.u.uMode, this.mode);
    gl.uniform1f(this.u.uSplit, this.split);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
