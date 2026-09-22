import React, { createContext, useContext, useEffect, useState } from 'react';

export type ThemeMode = 'dark' | 'light';

interface ThemeContextType {
  theme: ThemeMode;
  toggleTheme: () => void;
  setTheme: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('sp_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    }
    return 'dark'; // Default dark cyber theme
  });

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;

    root.setAttribute('data-theme', theme);
    body.setAttribute('data-theme', theme);

    if (theme === 'light') {
      root.classList.add('light-mode');
      root.classList.remove('dark');
      body.classList.add('light-mode');
      body.classList.remove('dark');
    } else {
      root.classList.remove('light-mode');
      root.classList.add('dark');
      body.classList.remove('light-mode');
      body.classList.add('dark');
    }

    localStorage.setItem('sp_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const setTheme = (mode: ThemeMode) => {
    setThemeState(mode);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
