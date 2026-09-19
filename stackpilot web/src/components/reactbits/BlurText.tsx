import React, { useEffect, useState, useRef } from 'react';

interface BlurTextProps {
  text: string;
  delay?: number;
  className?: string;
  animateBy?: 'words' | 'letters';
  direction?: 'top' | 'bottom';
}

export const BlurText: React.FC<BlurTextProps> = ({
  text,
  delay = 80,
  className = '',
  animateBy = 'words',
  direction = 'top',
}) => {
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
        }
      },
      { threshold: 0.1 }
    );

    if (ref.current) {
      observer.observe(ref.current);
    }
    return () => observer.disconnect();
  }, []);

  const elements = animateBy === 'words' ? text.split(' ') : text.split('');

  return (
    <p ref={ref} className={`flex flex-wrap ${className}`}>
      {elements.map((el, i) => (
        <span
          key={i}
          className="inline-block transition-all duration-700 ease-out"
          style={{
            transitionDelay: `${i * delay}ms`,
            filter: inView ? 'blur(0px)' : 'blur(10px)',
            opacity: inView ? 1 : 0,
            transform: inView
              ? 'translate3d(0,0,0)'
              : direction === 'top'
              ? 'translate3d(0,-20px,0)'
              : 'translate3d(0,20px,0)',
          }}
        >
          {el}
          {animateBy === 'words' && i < elements.length - 1 ? '\u00A0' : ''}
        </span>
      ))}
    </p>
  );
};
