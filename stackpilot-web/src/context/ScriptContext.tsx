import React, { createContext, useContext, useState } from 'react';
import { ScriptTab, SCRIPTS, ScriptOption } from '../config/scripts';

interface ScriptContextType {
  activeTab: ScriptTab;
  setActiveTab: (tab: ScriptTab) => void;
  activeScript: ScriptOption;
}

const ScriptContext = createContext<ScriptContextType | undefined>(undefined);

export const ScriptProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeTab, setActiveTab] = useState<ScriptTab>('bash');
  const activeScript = SCRIPTS.find((s) => s.id === activeTab) || SCRIPTS[0];

  return (
    <ScriptContext.Provider value={{ activeTab, setActiveTab, activeScript }}>
      {children}
    </ScriptContext.Provider>
  );
};

export const useScript = () => {
  const ctx = useContext(ScriptContext);
  if (!ctx) {
    throw new Error('useScript must be used within a ScriptProvider');
  }
  return ctx;
};
