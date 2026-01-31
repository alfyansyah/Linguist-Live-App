
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Visualizer } from './components/Visualizer';
import { Transcript } from './components/Transcript';
import { Message, SessionStatus, LearningConfig, GrammarTense } from './types';
import { 
  createPcmBlob, 
  decodeAudioData, 
  decodeFromBase64 
} from './services/audioUtils';

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const PRESET_TOPICS = [
  { id: 'daily', label: 'Daily Life', icon: '🏠', desc: 'Rutinitas harian & kebiasaan' },
  { id: 'travel', label: 'Travel', icon: '✈️', desc: 'Petualangan & liburan' },
  { id: 'food', label: 'Food & Dining', icon: '🍕', desc: 'Restoran & hobi masak' },
  { id: 'career', label: 'Career', icon: '💼', desc: 'Dunia kerja & interview' },
  { id: 'hobby', label: 'Entertainment', icon: '🎮', desc: 'Film, game & hobi' },
  { id: 'scifi', label: 'Sci-Fi Future', icon: '🚀', desc: 'Dunia masa depan' },
];

const ACTION_CHIPS = [
  "Bisa berikan kata yang lebih sulit?",
  "Apa ada idiom untuk topik ini?",
  "Tolong jelaskan grammar tadi.",
  "Ganti ke topik masa lalu.",
  "Bicara lebih pelan, tolong."
];

const App: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [currentOutput, setCurrentOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [learningConfig, setLearningConfig] = useState<LearningConfig>({
    language: 'English',
    level: 'Intermediate',
    focus: 'Fluency',
    topic: 'Daily Life',
    currentTense: 'Present (Situasi)'
  });
  const [customTopic, setCustomTopic] = useState('');

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const sessionRef = useRef<any>(null);

  // Detect Tense Change based on model output content
  useEffect(() => {
    if (currentOutput) {
      const lower = currentOutput.toLowerCase();
      // Simple heuristic pemicu perubahan status bar
      if (lower.includes("yesterday") || lower.includes("happened") || lower.includes("was it") || lower.includes("did you")) {
        setLearningConfig(prev => ({ ...prev, currentTense: 'Past (Masa Lalu)' }));
      } else if (lower.includes("tomorrow") || lower.includes("future") || lower.includes("will you") || lower.includes("going to")) {
        setLearningConfig(prev => ({ ...prev, currentTense: 'Future (Rencana)' }));
      }
    }
  }, [currentOutput]);

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
    setLearningConfig(prev => ({ ...prev, currentTense: 'Present (Situasi)' }));
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
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const activeTopic = customTopic || learningConfig.topic;

      const systemInstruction = `
        You are "Linguist Mentor", an elite AI language coach. 
        GOAL: Guide the user to mastery in ${learningConfig.language} (Level: ${learningConfig.level}).
        TARGET TOPIC: ${activeTopic}.

        STRUCTURE (THE GRAMMAR LADDER):
        - STEP 1 (Present/Situational): Start by exploring the topic in the present. Use simple present/continuous.
        - STEP 2 (Past/Narrative): After a few turns, smoothly bridge to the PAST. Ask about their previous experiences related to ${activeTopic}.
        - STEP 3 (Future/Hypothetical): Finally, push them to use future tenses or conditionals (e.g., "What if...", "Next time...", "In 10 years...").

        MANDATORY RULES:
        1. PROACTIVE ENGAGEMENT: Never end a turn without an open-ended question.
        2. NO DEAD ENDS: If the user gives a short answer, elaborate with an interesting fact or idiom about ${activeTopic} before questioning.
        3. SANDWICH FEEDBACK: If you hear an error, validate the meaning first, then provide "Correction: [Corrected sentence]" and a 1-sentence explanation, then continue the flow.
        4. TENSE DRIFTING: You must proactively "drift" the conversation across different tenses as per the ladder.
        
        TONE: Encouraging, professional, and intellectually stimulating.
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
              setCurrentOutput(prev => prev + (message.serverContent?.outputTranscription?.text || ''));
            } else if (message.serverContent?.inputTranscription) {
              const text = (message.serverContent.inputTranscription.text || '').replace(/<noise>|\[noise\]/gi, '').trim();
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

            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const audioCtx = outputAudioContextRef.current;
              if (!audioCtx) return;

              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioCtx.currentTime);
              const audioBuffer = await decodeAudioData(decodeFromBase64(base64Audio), audioCtx, OUTPUT_SAMPLE_RATE, 1);
              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAnalyser!);
              outputAnalyser!.connect(audioCtx.destination);
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
            console.error("Live Error:", e);
            setError('Koneksi terputus. Silakan coba lagi.');
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
      setError(err instanceof Error ? err.message : 'Gagal memulai sesi');
      setStatus(SessionStatus.DISCONNECTED);
    }
  };

  const selectTopic = (topic: string) => {
    setLearningConfig(prev => ({ ...prev, topic }));
    setCustomTopic('');
  };

  const getTenseStep = () => {
    switch (learningConfig.currentTense) {
      case 'Present (Situasi)': return 1;
      case 'Past (Masa Lalu)': return 2;
      case 'Future (Rencana)': return 3;
      default: return 1;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col p-4 md:p-6 max-w-7xl mx-auto h-screen overflow-hidden">
      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 flex-shrink-0">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-900/40 transform -rotate-3 hover:rotate-0 transition-transform">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
              <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-cyan-400">Linguist Live</h1>
            <p className="text-slate-500 text-xs font-medium uppercase tracking-widest">Mastery Edition • Ver 2.5</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className={`px-3 py-1.5 rounded-full border text-[10px] font-bold tracking-tighter uppercase ${
            status === SessionStatus.CONNECTED ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 
            status === SessionStatus.CONNECTING ? 'bg-amber-500/10 border-amber-500/50 text-amber-400 animate-pulse' : 
            'bg-slate-800 border-slate-700 text-slate-500'
          }`}>
            {status}
          </div>
          <button
            onClick={() => status === SessionStatus.CONNECTED ? disconnect() : connect()}
            className={`px-6 py-2 rounded-xl font-bold transition-all shadow-lg active:scale-95 ${
              status === SessionStatus.CONNECTED 
                ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-rose-900/20' 
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/20'
            }`}
          >
            {status === SessionStatus.CONNECTED ? 'Stop Session' : 'Start Mentor'}
          </button>
        </div>
      </header>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/50 text-rose-200 p-3 rounded-xl mb-4 text-sm flex items-center gap-2 animate-in slide-in-from-top-4">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
        </div>
      )}

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-0 overflow-hidden">
        {/* Left Column: Config & Tools */}
        <div className={`space-y-6 lg:col-span-1 transition-opacity ${status === SessionStatus.CONNECTED ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
          <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 backdrop-blur-sm">
            <h2 className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-4 flex items-center gap-2">
              <span className="w-1 h-3 bg-emerald-500 rounded-full"></span>
              Pilih Topik Diskusi
            </h2>
            <div className="grid grid-cols-2 gap-3 mb-4">
              {PRESET_TOPICS.map(t => (
                <button
                  key={t.id}
                  onClick={() => selectTopic(t.label)}
                  className={`flex flex-col items-center p-3 rounded-2xl border transition-all ${
                    learningConfig.topic === t.label ? 'bg-emerald-600/20 border-emerald-500 text-emerald-400' : 'bg-slate-800/40 border-slate-700 hover:border-slate-500 text-slate-400'
                  }`}
                >
                  <span className="text-2xl mb-1">{t.icon}</span>
                  <span className="text-[10px] font-bold uppercase truncate w-full text-center">{t.label}</span>
                </button>
              ))}
            </div>
            
            <div className="relative">
              <input 
                type="text"
                placeholder="Atau ketik topik bebas..."
                value={customTopic}
                onChange={(e) => setCustomTopic(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl py-3 px-4 text-sm focus:outline-none focus:border-emerald-500 transition-colors placeholder:text-slate-600"
              />
              <div className="absolute right-3 top-3.5 text-slate-700 pointer-events-none">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeWidth={2}/></svg>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 backdrop-blur-sm">
            <h2 className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-4 flex items-center gap-2">
              <span className="w-1 h-3 bg-cyan-500 rounded-full"></span>
              Focus Level
            </h2>
            <div className="grid grid-cols-4 gap-2">
              {['Starter', 'Beginner', 'Intermediate', 'Advanced'].map(lvl => (
                <button
                  key={lvl}
                  onClick={() => setLearningConfig(prev => ({ ...prev, level: lvl as any }))}
                  className={`py-2 rounded-lg text-[9px] font-bold uppercase border transition-all ${
                    learningConfig.level === lvl ? 'bg-cyan-600 border-cyan-500 text-white' : 'bg-slate-800/40 border-slate-700 text-slate-500'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Interaction Hub */}
        <div className="lg:col-span-2 flex flex-col min-h-0 relative">
          {/* Grammar Ladder Indicator */}
          {status === SessionStatus.CONNECTED && (
            <div className="bg-slate-900/80 border border-slate-800 backdrop-blur-md rounded-2xl p-4 mb-4 flex items-center justify-between gap-6 animate-in fade-in slide-in-from-right-4">
              <div className="flex-1">
                <div className="flex justify-between mb-2">
                   <span className="text-[10px] font-bold text-slate-500 uppercase">Grammar Progression</span>
                   <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">{learningConfig.currentTense}</span>
                </div>
                <div className="flex gap-2 h-1.5">
                  {[1, 2, 3].map(step => (
                    <div 
                      key={step} 
                      className={`flex-1 rounded-full transition-all duration-700 ${getTenseStep() >= step ? 'bg-emerald-500 shadow-sm shadow-emerald-500/50' : 'bg-slate-800'}`}
                    />
                  ))}
                </div>
              </div>
              <div className="bg-slate-800 rounded-lg px-3 py-1 border border-slate-700 text-[10px] font-bold text-slate-300">
                SCENARIO: {customTopic || learningConfig.topic}
              </div>
            </div>
          )}

          {/* Transcript Area */}
          <Transcript messages={messages} currentInput={currentInput} currentOutput={currentOutput} />

          {/* Footer Tools */}
          <div className="mt-4 flex flex-col gap-3 flex-shrink-0">
             {status === SessionStatus.CONNECTED && (
               <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                 {ACTION_CHIPS.map((chip, idx) => (
                   <button 
                    key={idx}
                    onClick={() => alert(`Coba katakan: "${chip}"`)}
                    className="whitespace-nowrap bg-slate-800/60 hover:bg-slate-700 border border-slate-700/50 px-4 py-1.5 rounded-full text-[11px] font-medium text-slate-300 transition-colors active:scale-95"
                   >
                     {chip}
                   </button>
                 ))}
               </div>
             )}

            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 flex items-center gap-6 shadow-2xl">
              <div className="flex-1 flex items-center gap-4 bg-slate-950 rounded-2xl px-4 py-2 border border-slate-800">
                <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <div className={`w-2 h-2 rounded-full ${status === SessionStatus.CONNECTED ? 'bg-emerald-500 animate-ping' : 'bg-slate-700'}`}></div>
                </div>
                <div className="flex-1">
                  <Visualizer 
                    analyser={status === SessionStatus.CONNECTED ? outputAnalyserRef.current : null} 
                    color={status === SessionStatus.CONNECTED ? '#10b981' : '#334155'}
                  />
                </div>
              </div>

              {status === SessionStatus.CONNECTED && (
                <div className="hidden sm:flex flex-col items-center">
                   <div className="w-10 h-10 rounded-full border-2 border-emerald-500/20 flex items-center justify-center mb-1">
                      <div className="w-6 h-6 rounded-full bg-emerald-500 animate-pulse"></div>
                   </div>
                   <span className="text-[8px] font-bold text-emerald-500 uppercase">Live Voice</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Decorative Gradient */}
      <div className="fixed -bottom-64 -right-64 w-[600px] h-[600px] bg-emerald-600/5 blur-[120px] rounded-full pointer-events-none -z-10"></div>
      <div className="fixed -top-64 -left-64 w-[600px] h-[600px] bg-cyan-600/5 blur-[120px] rounded-full pointer-events-none -z-10"></div>
    </div>
  );
};

export default App;
