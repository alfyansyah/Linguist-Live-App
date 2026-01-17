
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Visualizer } from './components/Visualizer';
import { Transcript } from './components/Transcript';
import { Message, SessionStatus, LearningConfig } from './types';
import { 
  createPcmBlob, 
  decodeAudioData, 
  decodeFromBase64 
} from './services/audioUtils';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const App: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [currentOutput, setCurrentOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [learningConfig, setLearningConfig] = useState<LearningConfig>({
    language: 'English',
    level: 'Intermediate',
    focus: 'Fluency'
  });

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const sessionRef = useRef<any>(null);

  const disconnect = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }
    
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    if (inputAudioContextRef.current) inputAudioContextRef.current.close();
    if (outputAudioContextRef.current) outputAudioContextRef.current.close();
    
    inputAudioContextRef.current = null;
    outputAudioContextRef.current = null;
    inputAnalyserRef.current = null;
    outputAnalyserRef.current = null;

    setStatus(SessionStatus.DISCONNECTED);
    setCurrentInput('');
    setCurrentOutput('');
  }, []);

  const connect = async () => {
    try {
      setStatus(SessionStatus.CONNECTING);
      setError(null);

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: INPUT_SAMPLE_RATE });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: OUTPUT_SAMPLE_RATE });
      
      const inputAnalyser = inputCtx.createAnalyser();
      inputAnalyser.fftSize = 256;
      const outputAnalyser = outputCtx.createAnalyser();
      outputAnalyser.fftSize = 256;
      
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;
      inputAnalyserRef.current = inputAnalyser;
      outputAnalyserRef.current = outputAnalyser;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const systemInstruction = `
        You are "Linguist Mentor", an expert personal language tutor. 
        Target Language: ${learningConfig.language}.
        Level: ${learningConfig.level}.
        Focus: ${learningConfig.focus}.

        CRITICAL TRANSCRIPTION RULE:
        - The user will speak in ${learningConfig.language} or Bahasa Indonesia. 
        - DO NOT transcribe any other languages (like Hindi, Thai, or Sanskrit). If you are unsure, prioritize transcribing as ${learningConfig.language}.
        - Ignore background noise tags like <noise>.

        BEHAVIOR GUIDELINES:
        1. Act like a supportive friend and professional mentor.
        2. BEHAVIOR BASED ON LEVEL:
           - Starter: YOU ARE A VOCABULARY QUIZ MASTER. 
             * ALWAYS ask questions in Bahasa Indonesia. 
             * Example: "Apa bahasa ${learningConfig.language}nya 'Kursi'?" atau "Bagaimana menyebut 'Saya lelah'?"
             * Expect the user to answer in ${learningConfig.language}. 
             * Give immediate enthusiastic feedback in Bahasa Indonesia.
             * If the user says something that sounds like noise or a different language, ask them to repeat clearly.
           - Beginner: Speak slowly in ${learningConfig.language}, use simple words. 
           - Intermediate: Natural flow, correcting grammar mistakes.
           - Advanced: Use idioms and complex structures.
        3. If you hear a mistake, use: "Correction: [Correct Version]".
        4. Provide "Tip: [Learning Tip]" occasionally.
        5. For Starter level, you take the lead 90% of the time.
      `;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (event) => {
              const inputData = event.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(inputAnalyser);
            inputAnalyser.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.outputTranscription) {
              setCurrentOutput(prev => prev + message.serverContent!.outputTranscription!.text);
            } else if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text.replace(/<noise>|\[noise\]/gi, '').trim();
              if (text) setCurrentInput(prev => prev + text);
            }

            if (message.serverContent?.turnComplete) {
              setCurrentInput(fullIn => {
                if (fullIn.trim()) {
                  setMessages(prev => [...prev, { 
                    id: Date.now().toString() + '-in', 
                    role: 'user', 
                    text: fullIn, 
                    type: 'chat',
                    timestamp: Date.now() 
                  }]);
                }
                return '';
              });
              setCurrentOutput(fullOut => {
                if (fullOut.trim()) {
                  const isCorrection = fullOut.toLowerCase().includes('correction:') || fullOut.toLowerCase().includes('tip:');
                  setMessages(prev => [...prev, { 
                    id: Date.now().toString() + '-out', 
                    role: 'model', 
                    text: fullOut, 
                    type: isCorrection ? 'correction' : 'chat',
                    timestamp: Date.now() 
                  }]);
                }
                return '';
              });
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const audioCtx = outputAudioContextRef.current;
              if (!audioCtx) return;

              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtx.currentTime);
              const audioBuffer = await decodeAudioData(decodeFromBase64(base64Audio), audioCtx, OUTPUT_SAMPLE_RATE, 1);
              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAnalyser);
              outputAnalyser.connect(audioCtx.destination);
              source.addEventListener('ended', () => { sourcesRef.current.delete(source); });
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            setError('Connection error. Retrying...');
            disconnect();
          },
          onclose: () => disconnect()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize session');
      setStatus(SessionStatus.DISCONNECTED);
    }
  };

  const handleToggleSession = () => {
    if (status === SessionStatus.CONNECTED) disconnect();
    else connect();
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col p-4 md:p-6 max-w-6xl mx-auto h-screen overflow-hidden">
      {/* App Header */}
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-900/40">
            <svg width="28" height="28" className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight bg-gradient-to-r from-emerald-400 to-teal-200 bg-clip-text text-transparent">Linguist Live</h1>
            <p className="text-xs text-slate-400 font-bold tracking-widest uppercase">Mentor Bahasa Real-time</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col">
            <label className="text-[10px] text-slate-500 font-bold uppercase mb-1">Bahasa</label>
            <select 
              className="bg-slate-900 border border-slate-800 text-xs rounded-lg px-2 py-1 outline-none"
              value={learningConfig.language}
              onChange={(e) => setLearningConfig({...learningConfig, language: e.target.value})}
              disabled={status !== SessionStatus.DISCONNECTED}
            >
              <option>English</option>
              <option>Bahasa Indonesia</option>
              <option>Japanese</option>
              <option>French</option>
              <option>German</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-[10px] text-slate-500 font-bold uppercase mb-1">Level</label>
            <select 
              className="bg-slate-900 border border-slate-800 text-xs rounded-lg px-2 py-1 outline-none"
              value={learningConfig.level}
              onChange={(e) => setLearningConfig({...learningConfig, level: e.target.value as any})}
              disabled={status !== SessionStatus.DISCONNECTED}
            >
              <option>Starter</option>
              <option>Beginner</option>
              <option>Intermediate</option>
              <option>Advanced</option>
            </select>
          </div>
          <div className="flex items-center gap-2 mt-auto">
            <span className={`w-2 h-2 rounded-full ${status === SessionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-700'}`} />
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{status}</span>
          </div>
        </div>
      </header>

      {/* Main Experience */}
      <main className="flex-1 flex flex-col md:flex-row gap-6 min-h-0">
        <div className="w-full md:w-1/3 flex flex-col gap-4 flex-shrink-0">
          <div className="bg-slate-900/50 p-6 rounded-3xl border border-slate-800/50 flex-1 flex flex-col justify-center items-center relative overflow-hidden">
            <div className="absolute top-4 left-4 flex items-center gap-2">
               <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
               <span className="text-[10px] font-bold text-emerald-500 uppercase">Live Session</span>
            </div>

            <div className="mb-8 w-full">
              <p className="text-center text-xs font-bold text-slate-500 uppercase mb-4 tracking-widest">User Audio</p>
              <Visualizer analyser={inputAnalyserRef.current} color="#10b981" />
            </div>

            <div className="w-full">
              <p className="text-center text-xs font-bold text-slate-500 uppercase mb-4 tracking-widest">Mentor Audio</p>
              <Visualizer analyser={outputAnalyserRef.current} color="#2dd4bf" />
            </div>

            <div className="mt-8 text-center">
              <p className="text-sm text-slate-400 italic">"Belajarlah dari kesalahan, itu adalah kunci kemajuan."</p>
            </div>
          </div>

          <button
            onClick={handleToggleSession}
            disabled={status === SessionStatus.CONNECTING}
            className={`
              w-full py-5 rounded-2xl font-black text-lg transition-all transform active:scale-95 shadow-xl
              ${status === SessionStatus.CONNECTED 
                ? 'bg-red-500/10 text-red-500 border border-red-500/30 hover:bg-red-500/20' 
                : 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-emerald-900/20'}
            `}
          >
            {status === SessionStatus.CONNECTED ? 'AKHIRI SESI' : status === SessionStatus.CONNECTING ? 'MENGHUBUNGKAN...' : 'MULAI BELAJAR'}
          </button>
        </div>

        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-3">
             <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
               <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
               </svg>
               Catatan Sesi
             </h2>
             <button 
              onClick={() => setMessages([])}
              className="text-[10px] text-slate-600 hover:text-slate-400 font-bold uppercase transition-colors"
             >
               Bersihkan
             </button>
          </div>
          <Transcript messages={messages} currentInput={currentInput} currentOutput={currentOutput} />
          
          {error && (
            <div className="mt-4 p-3 bg-red-900/30 border border-red-500/20 rounded-xl text-red-400 text-xs flex items-center gap-2">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              {error}
            </div>
          )}
        </div>
      </main>

      <footer className="mt-6 flex flex-col md:flex-row items-center justify-between gap-4 py-4 border-t border-slate-900">
        <div className="flex gap-4 text-[10px] font-bold text-slate-600 uppercase tracking-widest">
           <span>Evaluasi Real-time</span>
           <span>Grammar Check</span>
           <span>Fluency Coaching</span>
        </div>
        <div className="text-[10px] text-slate-500">
          Teknologi Gemini 2.5 Native Audio &bull; Dirancang untuk Pembelajar
        </div>
      </footer>
    </div>
  );
};

export default App;
