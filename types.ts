
export interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  type: 'chat' | 'correction' | 'tip';
  timestamp: number;
}

export enum SessionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface LearningConfig {
  language: string;
  level: 'Starter' | 'Beginner' | 'Intermediate' | 'Advanced';
  focus: 'Fluency' | 'Grammar' | 'Vocabulary' | 'Pronunciation';
}
