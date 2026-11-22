import { useEffect, useRef } from "react";

import { isTauriRuntime } from "@/bridge/env";
import { setNativeFftEnabled, subscribeNativeFft } from "@/bridge/native-audio";
import { audio as audioElement } from "@/store/play-list";

interface AudioWaveformProps {
  width?: number;
  height?: number;
  barCount?: number;
  barColor?: string;
}

// Global AudioContext singleton to prevent multiple MediaElementSourceNode creation
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaElementAudioSourceNode | null = null;
let reusableFrequencyBuffer: Uint8Array<ArrayBuffer> | null = null;

/**
 * 音频波形可视化组件
 * 在 Tauri 原生音频引擎下直接订阅 Rust 端 FFT 频谱，非 Tauri 环境回退 Web Audio API
 */
const AudioWaveform = ({ width = 56, height = 56, barCount = 40, barColor = "currentColor" }: AudioWaveformProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationIdRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !audioElement) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const drawBars = (values: ArrayLike<number>, length: number) => {
      ctx.clearRect(0, 0, width, height);

      const computedBarWidth = width / barCount;
      const barGap = computedBarWidth * 0.2;
      const barWidth = computedBarWidth - barGap;
      const fill = barColor === "currentColor" ? "#666" : barColor;
      ctx.fillStyle = fill;

      for (let i = 0; i < barCount; i++) {
        const dataIndex = length > 0 ? Math.min(length - 1, Math.floor((i / barCount) * length)) : 0;
        const raw = length > 0 ? values[dataIndex] : 0;
        const boost = 1 + i / barCount;
        const value = Math.min(255, raw * boost);
        const barHeight = Math.max((value / 255) * height, 2);
        const x = i * computedBarWidth;
        const y = height - barHeight;

        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barWidth, barHeight, 2);
        } else {
          ctx.fillRect(x, y, barWidth, barHeight);
        }
        ctx.fill();
      }
    };

    if (isTauriRuntime()) {
      let active = true;
      let unlisten: (() => void) | undefined;
      const empty = new Uint8Array(barCount);
      drawBars(empty, empty.length);

      setNativeFftEnabled(true);
      void subscribeNativeFft(bars => {
        if (!active) return;
        drawBars(bars, bars.length);
      }).then(fn => {
        if (active) unlisten = fn;
        else fn();
      });

      return () => {
        active = false;
        unlisten?.();
        setNativeFftEnabled(false);
      };
    }

    // Initialize AudioContext and Analyser if not already done
    const initAudio = () => {
      if (!audioContext) {
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512; // Increased for better resolution
        reusableFrequencyBuffer = new Uint8Array(analyser.frequencyBinCount);

        try {
          // Connect the global audio element to the analyser
          source = audioContext.createMediaElementSource(audioElement);
          source.connect(analyser);
          analyser.connect(audioContext.destination);
        } catch (error) {
          console.warn("MediaElementSourceNode already connected or creation failed:", error);
        }
      }
      if (audioContext?.state === "suspended") {
        audioContext.resume();
      }
    };

    // Initialize on mount
    initAudio();

    // Ensure context resumes on play
    const handlePlay = () => {
      if (audioContext?.state === "suspended") {
        audioContext.resume();
      }
      if (!animationIdRef.current) {
        render();
      }
    };

    const handlePause = () => {
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
        animationIdRef.current = 0;
      }
    };

    const draw = () => {
      if (!analyser || !ctx) return;

      const bufferLength = analyser.frequencyBinCount;
      if (!reusableFrequencyBuffer || reusableFrequencyBuffer.length !== bufferLength) {
        reusableFrequencyBuffer = new Uint8Array(bufferLength);
      }
      const dataArray = reusableFrequencyBuffer;
      analyser.getByteFrequencyData(dataArray);

      const usefulBufferLength = Math.floor(bufferLength * 0.6);
      drawBars(dataArray, usefulBufferLength);
    };

    const render = () => {
      draw();
      animationIdRef.current = requestAnimationFrame(render);
    };

    audioElement.addEventListener("play", handlePlay);
    audioElement.addEventListener("pause", handlePause);

    // Initialize state
    if (!audioElement.paused) {
      render();
    } else {
      draw();
    }

    return () => {
      if (animationIdRef.current) {
        cancelAnimationFrame(animationIdRef.current);
      }
      audioElement.removeEventListener("play", handlePlay);
      audioElement.removeEventListener("pause", handlePause);
    };
  }, [width, height, barCount, barColor]);

  return <canvas ref={canvasRef} width={width} height={height} />;
};

export default AudioWaveform;
