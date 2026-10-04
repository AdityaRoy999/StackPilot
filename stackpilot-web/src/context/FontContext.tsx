import React, { createContext, useContext, useEffect, useState } from 'react';

export type FontMode = 'stylish' | 'normal';

interface FontContextType {
  fontMode: FontMode;
  toggleFontMode: () => void;
  setFontMode: (mode: FontMode) => void;
}

const FontContext = createContext<FontContextType | undefined>(undefined);

export const FontProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [fontMode, setFontModeState] = useState<FontMode>(() => {
    if (typeof window !== 'undefined') {
      const explicit = localStorage.getItem('sp_font_mode_explicit');
      if (explicit === 'true') {
        const saved = localStorage.getItem('sp_font_mode');
        if (saved === 'normal' || saved === 'stylish') return saved;
      }
    }
    return 'normal';
  });

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.setAttribute('data-font', fontMode);
    body.setAttribute('data-font', fontMode);

    if (fontMode === 'stylish') {
      root.classList.add('font-stylish');
      root.classList.remove('font-normal-mode');
      body.classList.add('font-stylish');
      body.classList.remove('font-normal-mode');
    } else {
      root.classList.add('font-normal-mode');
      root.classList.remove('font-stylish');
      body.classList.add('font-normal-mode');
      body.classList.remove('font-stylish');
    }
    localStorage.setItem('sp_font_mode', fontMode);
  }, [fontMode]);

  const toggleFontMode = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('sp_font_mode_explicit', 'true');
    }
    setFontModeState((prev) => (prev === 'stylish' ? 'normal' : 'stylish'));
  };

  const setFontMode = (mode: FontMode) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('sp_font_mode_explicit', 'true');
    }
    setFontModeState(mode);
  };

  return (
    <FontContext.Provider value={{ fontMode, toggleFontMode, setFontMode }}>
      {children}
    </FontContext.Provider>
  );
};

export const useFont = () => {
  const context = useContext(FontContext);
  if (!context) {
    throw new Error('useFont must be used within a FontProvider');
  }
  return context;
};
