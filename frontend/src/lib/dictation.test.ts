import { expect, it } from 'vitest';
import { dictationText } from './dictation';

it('keeps the typed prefix and replaces interim speech rather than repeating it',()=>{
  const prefix='Please';
  expect(dictationText(prefix,'check')).toBe('Please check');
  expect(dictationText(prefix,'check the deployment')).toBe('Please check the deployment');
  expect(dictationText('','')).toBe('');
});
