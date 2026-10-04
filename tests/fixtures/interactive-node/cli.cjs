const readline = require('readline');
console.log('Enter a number:');
readline.createInterface({input: process.stdin}).on('line', text => {
  const value = Number(text);
  console.log(Number.isFinite(value) ? `Square: ${value * value}` : 'Invalid number');
  console.log('Enter a number:');
});
