import { useRef, useCallback, useState } from "react";

export type MicStatus = "idle" | "requesting" | "listening" | "denied" | "error";

/**
 * Captures microphone audio and converts it to 16-bit PCM at 16kHz — the
 * format AssemblyAI's realtime API expects (see
 * server/src/services/speech/realtimeTranscribe.ts). Uses a
 * ScriptProcessorNode for broad browser compatibility; an AudioWorklet
 * would be the more modern replacement but ScriptProcessor works
 * everywhere today without extra worklet file bundling.
 */
export function useMicStream(onChunk: (pcm16: ArrayBuffer) => void) {
  const [status, setStatus] = useState<MicStatus>("idle");
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const start = useCallback(async () => {
    setStatus("requesting");
    try {
      // echoCancellation MUST be off for this capture. It's on by default in
      // getUserMedia, and its whole job is to detect "the mic is hearing
      // audio that just came out of this device's own speakers" and
      // subtract it back out. Below, the ScriptProcessorNode is (necessarily)
      // wired into the audio graph, which — if it reached real speakers —
      // would mean the user's own voice gets played back and then the
      // browser's echo canceller treats their own live speech as "echo" and
      // suppresses it, so what NEXUS ends up sending to AssemblyAI can be
      // silent/garbled even though the raw mic signal is fine. This was the
      // root cause of "nothing gets transcribed at all": everything else in
      // the pipeline was already correct, but the actual audio content
      // reaching the server was being cancelled out at the source. Turning
      // AEC off here removes that risk entirely, on top of the routing fix
      // below.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      // Browsers can create a new AudioContext in a "suspended" state under
      // their autoplay/audio policies, and only auto-resume it when audio
      // starts inside the SAME synchronous call stack as a user gesture
      // (e.g. a click handler). Here mic.start() is invoked from an async
      // socket callback ("meeting_joined") that fires well after the
      // original "Join Meeting" click returned — outside that window — so
      // the context can stay suspended indefinitely: onaudioprocess simply
      // never fires, no error is thrown anywhere, and zero audio ever
      // reaches AssemblyAI even though every other part of the pipeline
      // looks and behaves correctly. Explicitly resuming closes that gap.
      if (audioContext.state === "suspended") await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const pcm16 = downsampleAndConvertToPCM16(input, audioContext.sampleRate, 16000);
        if (pcm16) onChunk(pcm16);
      };

      // ScriptProcessorNode only fires onaudioprocess while it's part of an
      // audio graph that reaches a destination — but connecting it straight
      // to audioContext.destination (i.e. the user's real speakers) plays
      // the user's own mic back to them live. Best case that's just an
      // unpleasant, disorienting echo/feedback howl that makes people mute
      // or bail out before ever getting a clean test in; worst case (see
      // the echoCancellation comment above) it actively breaks
      // transcription. A muted GainNode keeps the graph "live" so the
      // processor keeps firing, without ever reaching real speakers.
      const silentOutput = audioContext.createGain();
      silentOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(audioContext.destination);

      setStatus("listening");
    } catch (err: any) {
      setStatus(err?.name === "NotAllowedError" ? "denied" : "error");
    }
  }, [onChunk]);

  const stop = useCallback(() => {
    processorRef.current?.disconnect();
    audioContextRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    processorRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
    setStatus("idle");
  }, []);

  return { status, start, stop };
}

function downsampleAndConvertToPCM16(
  input: Float32Array,
  inputSampleRate: number,
  targetSampleRate: number
): ArrayBuffer | null {
  if (targetSampleRate > inputSampleRate) return null;

  const ratio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Int16Array(newLength);

  let offsetResult = 0;
  let offsetInput = 0;
  while (offsetResult < newLength) {
    const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    result[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult++;
    offsetInput = nextOffsetInput;
  }

  return result.buffer;
}
