import { motion } from "motion/react";
import { AssistantState } from "../types";

interface MyraaWaveformProps {
  state: AssistantState;
  volume: number; // Volume value (0 to 100+)
  onClick?: () => void;
}

export default function MyraaWaveform({ state, volume, onClick }: MyraaWaveformProps) {
  // Normalize volume for animations (typically 0 to 1)
  const normalizedVolume = Math.min(1, volume / 120);

  // Define styling based on state
  const getThemeColors = () => {
    switch (state) {
      case "disconnected":
        return {
          glow: "rgba(100, 116, 139, 0.2)", // Slate grey glow
          border: "border-slate-500/30",
          gradient: "from-slate-600/20 to-slate-400/20",
          particle: "bg-slate-400",
          bars: "from-slate-500 to-slate-400",
        };
      case "connecting":
        return {
          glow: "rgba(245, 158, 11, 0.35)", // Amber/gold glow
          border: "border-amber-500/40",
          gradient: "from-amber-500/20 to-yellow-500/20",
          particle: "bg-amber-400",
          bars: "from-amber-500 to-yellow-400",
        };
      case "listening":
        return {
          glow: "rgba(6, 182, 212, 0.45)", // Cyan/Teal active listening glow
          border: "border-cyan-500/55",
          gradient: "from-cyan-500/20 to-teal-500/20",
          particle: "bg-cyan-400",
          bars: "from-cyan-500 to-teal-400",
        };
      case "speaking":
        return {
          glow: "rgba(236, 72, 153, 0.55)", // Pink/Purple vibrant speaking glow
          border: "border-pink-500/60",
          gradient: "from-pink-500/20 to-indigo-500/20",
          particle: "bg-pink-400",
          bars: "from-pink-500 to-indigo-500",
        };
    }
  };

  const colors = getThemeColors();

  // Create an array of 13 bars for the voice visualizer
  const barCount = 13;
  const bars = Array.from({ length: barCount });

  return (
    <div className="relative flex flex-col items-center justify-center w-full max-w-xl mx-auto aspect-square">
      {/* Symmetrical Waveforms in Background */}
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center justify-between px-4 pointer-events-none z-0">
        {/* Left Side Symmetrical Waveform */}
        <div className="flex items-end space-x-1.5 h-24 opacity-25">
          {[8, 16, 12, 24, 20, 10].map((h, i) => {
            const dynamicH = state === "speaking" || state === "listening" 
              ? h + (normalizedVolume * 35) * (i % 2 === 0 ? 0.7 : 1.3)
              : h + Math.sin(Date.now() / 300 + i) * 3;
            return (
              <motion.div
                key={`left-wave-${i}`}
                className="waveform-bar"
                animate={{ height: Math.max(4, dynamicH) }}
                transition={{ type: "spring", stiffness: 200, damping: 15 }}
                style={{ width: "4px" }}
              />
            );
          })}
        </div>

        {/* Right Side Symmetrical Waveform */}
        <div className="flex items-end space-x-1.5 h-24 opacity-25 transform scale-x-[-1]">
          {[8, 16, 12, 24, 20, 10].map((h, i) => {
            const dynamicH = state === "speaking" || state === "listening"
              ? h + (normalizedVolume * 35) * (i % 2 === 0 ? 1.1 : 0.9)
              : h + Math.cos(Date.now() / 300 + i) * 3;
            return (
              <motion.div
                key={`right-wave-${i}`}
                className="waveform-bar"
                animate={{ height: Math.max(4, dynamicH) }}
                transition={{ type: "spring", stiffness: 200, damping: 15 }}
                style={{ width: "4px" }}
              />
            );
          })}
        </div>
      </div>

      {/* Symmetrical Sizing Concentric Outer Rings */}
      <motion.div
        className="absolute w-[360px] h-[360px] border border-cyan-500/10 rounded-full pointer-events-none z-0"
        animate={{
          scale: state === "speaking" ? 1.05 + normalizedVolume * 0.1 : state === "listening" ? 1.02 + normalizedVolume * 0.05 : 1,
        }}
        transition={{ type: "spring", stiffness: 100, damping: 20 }}
      />
      <motion.div
        className="absolute w-[300px] h-[300px] border border-purple-500/10 rounded-full pointer-events-none z-0"
        animate={{
          scale: state === "speaking" ? 1.08 + normalizedVolume * 0.15 : state === "listening" ? 1.04 + normalizedVolume * 0.07 : 1,
        }}
        transition={{ type: "spring", stiffness: 100, damping: 20, delay: 0.05 }}
      />
      <div className="absolute w-[240px] h-[240px] border border-white/5 rounded-full pointer-events-none z-0" />

      {/* Outer Glowing Atmosphere */}
      <motion.div
        className="absolute w-72 h-72 rounded-full blur-3xl opacity-50 pointer-events-none transition-colors duration-1000 z-0"
        style={{
          background: colors.glow,
        }}
        animate={{
          scale: state === "speaking" ? 1.2 + normalizedVolume * 0.4 : state === "listening" ? 1.1 + normalizedVolume * 0.2 : 0.95,
        }}
        transition={{
          type: "spring",
          stiffness: 120,
          damping: 20,
        }}
        id="waveform-glow-sphere"
      />

      {/* Ripple Rings */}
      {state === "speaking" && (
        <>
          <motion.div
            className="absolute border border-pink-500/20 rounded-full pointer-events-none"
            initial={{ width: 140, height: 140, opacity: 0.8 }}
            animate={{
              width: 320,
              height: 320,
              opacity: 0,
            }}
            transition={{
              repeat: Infinity,
              duration: 2.2,
              ease: "easeOut",
            }}
            id="ripple-outer-1"
          />
          <motion.div
            className="absolute border border-indigo-500/10 rounded-full pointer-events-none"
            initial={{ width: 140, height: 140, opacity: 0.6 }}
            animate={{
              width: 260,
              height: 260,
              opacity: 0,
            }}
            transition={{
              repeat: Infinity,
              duration: 2.2,
              delay: 0.7,
              ease: "easeOut",
            }}
            id="ripple-outer-2"
          />
        </>
      )}

      {state === "listening" && (
        <motion.div
          className="absolute border border-cyan-500/20 rounded-full pointer-events-none"
          animate={{
            scale: 1 + normalizedVolume * 0.5,
            opacity: 0.3 + normalizedVolume * 0.7,
          }}
          transition={{
            type: "spring",
            stiffness: 150,
            damping: 15,
          }}
          style={{ width: "200px", height: "200px" }}
          id="ripple-listening"
        />
      )}

      {/* Inner Central Glass Orb (The core) */}
      <motion.div
        onClick={onClick}
        className={`relative flex items-center justify-center w-48 h-48 rounded-full glass-panel myraa-core-glow z-10 transition-all duration-700 cursor-pointer select-none`}
        whileTap={{ scale: 0.95 }}
        animate={{
          scale: state === "speaking" ? 1 + normalizedVolume * 0.12 : state === "listening" ? 1 + normalizedVolume * 0.08 : 1.0,
        }}
        id="central-glass-orb"
      >
        {/* Status Orbital Badge placed directly above the core */}
        <div className="absolute -top-4 px-5 py-1.5 glass-panel rounded-full border border-cyan-500/35 bg-slate-950/90 shadow-[0_0_15px_rgba(34,211,238,0.2)]">
          <span className="text-[10px] uppercase tracking-widest text-cyan-400 font-bold font-mono">
            {state === "disconnected" && "Offline"}
            {state === "connecting" && "Syncing"}
            {state === "listening" && "Listening"}
            {state === "speaking" && "Speaking"}
          </span>
        </div>

        {/* Animated Orbits or States */}
        {state === "disconnected" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {/* Elegant sleeping orbit */}
            <motion.div
              className="w-36 h-36 rounded-full border border-dashed border-slate-600/20"
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 25, ease: "linear" }}
            />
            <motion.div
              className="absolute w-2 h-2 bg-slate-500 rounded-full shadow-[0_0_8px_#64748b]"
              style={{ x: 72 }}
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 15, ease: "linear" }}
            />
          </div>
        )}

        {state === "connecting" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {/* Energetic scanning ring */}
            <motion.div
              className="w-38 h-38 rounded-full border-t border-b border-cyan-400/30"
              animate={{ rotate: -360 }}
              transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
            />
            <motion.div
              className="w-32 h-32 rounded-full border-l border-r border-purple-500/30"
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 4, ease: "linear" }}
            />
          </div>
        )}

        {/* Dancing Waveform Bars */}
        <div className="flex items-center justify-center gap-[5px] h-20 px-4 w-full" id="waveform-dancing-bars">
          {bars.map((_, idx) => {
            // Distribute heights so they form an elegant wave-shape from center to sides
            const distanceFromCenter = Math.abs(idx - (barCount - 1) / 2);
            const centerFactor = 1 - distanceFromCenter / ((barCount - 1) / 2 + 0.5); // 0.1 to 1.0

            // Base and dynamic height multipliers
            let minH = 6;
            let scaleH = 0;

            if (state === "disconnected") {
              minH = 4 + Math.sin(idx * 0.5) * 2;
              scaleH = 0;
            } else if (state === "connecting") {
              minH = 6;
              scaleH = 12 * Math.sin(Date.now() / 200 + idx * 0.6) * centerFactor;
            } else if (state === "listening") {
              minH = 8;
              scaleH = normalizedVolume * 64 * centerFactor * (0.4 + Math.random() * 0.6);
            } else if (state === "speaking") {
              minH = 10;
              scaleH = normalizedVolume * 76 * centerFactor * (0.6 + Math.random() * 0.4);
            }

            const barHeight = Math.max(4, minH + Math.abs(scaleH));

            return (
              <motion.div
                key={idx}
                className={`w-[4px] rounded-full bg-gradient-to-t ${colors.bars} shadow-lg shadow-black/10`}
                animate={{
                  height: barHeight,
                }}
                transition={{
                  type: "spring",
                  stiffness: state === "disconnected" ? 30 : 250,
                  damping: state === "disconnected" ? 10 : 22,
                  mass: 0.7,
                }}
              />
            );
          })}
        </div>

        {/* Small Elegant Core Ring */}
        <div className="absolute w-24 h-24 rounded-full border border-white/5 bg-white/2 pointer-events-none" />
      </motion.div>

      {/* State Status Text Display */}
      <div className="mt-12 text-center z-10" id="assistant-status-text">
        <motion.p
          className="font-mono text-[10px] tracking-widest uppercase transition-all duration-300 select-none opacity-40 font-bold"
          animate={{
            color:
              state === "disconnected"
                ? "#64748b"
                : state === "connecting"
                ? "#f59e0b"
                : state === "listening"
                ? "#22d3ee"
                : "#a855f7",
          }}
        >
          {state === "disconnected" && "System Inactive"}
          {state === "connecting" && "Synchronizing Myraa..."}
          {state === "listening" && "Duplex Voice Secure"}
          {state === "speaking" && "Active Response Stream"}
        </motion.p>

        <motion.h2
          key={state}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-white text-base font-light tracking-widest mt-1 uppercase"
        >
          {state === "disconnected" && "Tap to establish neural link"}
          {state === "connecting" && "Syncing core arrays"}
          {state === "listening" && "Go ahead, talk to me"}
          {state === "speaking" && "Myraa Voice Response"}
        </motion.h2>
      </div>
    </div>
  );
}
