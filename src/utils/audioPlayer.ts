export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStartTime: number = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private sampleRate: number = 24000; // Gemini Live API outputs at 24kHz PCM

  constructor(sampleRate: number = 24000) {
    this.sampleRate = sampleRate;
  }

  /**
   * Initializes the AudioContext and AnalyserNode.
   * Safe to call repeatedly; only creates if not already initialized.
   */
  init() {
    if (!this.ctx) {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        this.ctx = new AudioContextClass({
          sampleRate: this.sampleRate,
        });
        
        // Setup analyser for visualization
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 64; // Small fft size for quick frequency monitoring
        this.analyser.connect(this.ctx.destination);
        
        this.nextStartTime = this.ctx.currentTime;
      } catch (err) {
        console.error("Failed to initialize speaker AudioContext:", err);
      }
    }
    
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  /**
   * Enqueues a base64 PCM16 24kHz audio chunk for playback.
   */
  playChunk(base64Data: string) {
    this.init();
    if (!this.ctx || !this.analyser) return;

    try {
      // Decode base64 to binary string
      const binary = atob(base64Data);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      // Convert little-endian 16-bit signed PCM to Float32
      const int16Array = new Int16Array(bytes.buffer);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      // Create AudioBuffer
      const audioBuffer = this.ctx.createBuffer(1, float32Array.length, this.sampleRate);
      audioBuffer.copyToChannel(float32Array, 0);

      // Create Source Node
      const source = this.ctx.createBufferSource();
      source.buffer = audioBuffer;
      
      // Connect to analyser instead of destination directly
      source.connect(this.analyser);

      // Schedule exact gapless playback
      const now = this.ctx.currentTime;
      if (this.nextStartTime < now) {
        // Reset scheduling pointer if there was a gap/silence
        this.nextStartTime = now + 0.05; // 50ms buffer to prevent initial pop
      }

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.activeSources.push(source);

      source.onended = () => {
        this.activeSources = this.activeSources.filter((s) => s !== source);
      };
    } catch (err) {
      console.error("Error decoding or playing speaker audio chunk:", err);
    }
  }

  /**
   * Retrieves the current real-time volume (0 to 255) for waveform visualization.
   */
  getVolume(): number {
    if (!this.analyser) return 0;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    
    // Average volume across frequencies
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    return dataArray.length > 0 ? sum / dataArray.length : 0;
  }

  /**
   * Halts all scheduled audio immediately.
   */
  stop() {
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        // Source might have already ended or not started yet
      }
    });
    this.activeSources = [];
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime;
    }
  }

  /**
   * Releases resources.
   */
  close() {
    this.stop();
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch (e) {
        console.error("Error closing AudioContext:", e);
      }
      this.ctx = null;
      this.analyser = null;
    }
  }
}
