
import React, { useEffect, useRef } from 'react';
import { Message } from '../types';

interface TranscriptProps {
  messages: Message[];
  currentInput: string;
  currentOutput: string;
}

export const Transcript: React.FC<TranscriptProps> = ({ messages, currentInput, currentOutput }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, currentInput, currentOutput]);

  const renderMessage = (msg: Message) => {
    const isModel = msg.role === 'model';
    const isCorrection = msg.text.toLowerCase().includes('correction:') || msg.text.toLowerCase().includes('tip:');

    let bubbleClass = isModel 
      ? 'bg-slate-800 text-slate-200 border-slate-700' 
      : 'bg-emerald-600 text-white border-transparent';
    
    if (isCorrection) {
      bubbleClass = 'bg-amber-900/40 text-amber-200 border-amber-500/50 italic';
    }

    return (
      <div 
        key={msg.id}
        className={`flex ${isModel ? 'justify-start' : 'justify-end'} animate-in fade-in slide-in-from-bottom-2 duration-300`}
      >
        <div className={`max-w-[85%] p-3 rounded-2xl text-sm border shadow-sm ${bubbleClass} ${isModel ? 'rounded-tl-none' : 'rounded-tr-none'}`}>
          {msg.text.split('\n').map((line, i) => (
            <p key={i} className={i > 0 ? 'mt-2' : ''}>{line}</p>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div 
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-md shadow-inner"
    >
      {messages.length === 0 && !currentInput && !currentOutput && (
        <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center px-6">
          <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <h3 className="text-slate-300 font-semibold mb-2">Siap untuk Sesi Belajar?</h3>
          <p className="text-xs max-w-xs">Saya adalah Mentor Linguist Anda. Klik tombol di bawah untuk mulai berlatih bahasa secara langsung.</p>
        </div>
      )}
      
      {messages.map(renderMessage)}

      {(currentInput || currentOutput) && (
        <>
          {currentInput && (
            <div className="flex justify-end opacity-70">
              <div className="max-w-[80%] p-3 rounded-2xl text-sm bg-emerald-600/30 text-white rounded-tr-none border border-emerald-500/20 animate-pulse">
                {currentInput}
              </div>
            </div>
          )}
          {currentOutput && (
            <div className="flex justify-start opacity-70">
              <div className="max-w-[80%] p-3 rounded-2xl text-sm bg-slate-800/30 text-slate-300 rounded-tl-none border border-slate-700/20 animate-pulse">
                {currentOutput}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
