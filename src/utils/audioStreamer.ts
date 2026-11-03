export class AudioStreamer {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private sampleRate: number = 16000; // Gemini Live API expects 16kHz input PCM

  constructor(sampleRate: number = 16000) {
    this.sampleRate = sampleRate;
  }

  /**
   * Requests microphone access and begins recording, pushing raw PCM chunks
   * converted to base64 to the provided callback.
   */
  async start(onAudioChunk: (base64PCM: string) => void) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioContextClass({ sampleRate: this.sampleRate });
      this.source = this.audioCtx.createMediaStreamSource(this.stream);

      // Create AnalyserNode to monitor microphone levels in real-time
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 64;
      this.source.connect(this.analyser);

      // Create ScriptProcessorNode with buffer size of 4096 (approx 256ms chunk duration)
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      this.source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);

      this.processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBuffer = this.floatTo16BitPCM(inputData);
        const base64PCM = this.arrayBufferToBase64(pcmBuffer);
        onAudioChunk(base64PCM);
      };
    } catch (err) {
      console.error("Failed to start audio stream capturing:", err);
      throw err;
    }
  }

  /**
   * Retrieves the current microphone average volume (0 to 255).
   */
  getVolume(): number {
    if (!this.analyser) return 0;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    return dataArray.length > 0 ? sum / dataArray.length : 0;
  }

  /**
   * Stops recording and releases microphone resources.
   */
  stop() {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch (e) {}
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch (e) {}
      this.source = null;
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch (e) {}
      this.analyser = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      this.stream = null;
    }
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {
        console.error("Error closing microphone AudioContext:", e);
      }
      this.audioCtx = null;
    }
  }

  /**
   * Convers Float32 floating-point samples [-1.0, 1.0] to raw Int16 PCM bytes.
   */
  private floatTo16BitPCM(input: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < input.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      // Map float range [-1.0, 1.0] to 16-bit signed int range [-32768, 32767]
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(offset, val, true); // true for little-endian byte ordering
    }
    return buffer;
  }

  /**
   * Encodes an ArrayBuffer into a base64 encoded string.
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}
