from pathlib import Path
import qualification_math

# Test the built/installed package rather than accidentally importing source.
assert 'site-packages' in str(Path(qualification_math.__file__))
assert qualification_math.add(12, 30) == 42
assert qualification_math.multiply(6, 7) == 42
assert qualification_math.add(-7, 2) == -5
print('Built and installed package behavior passed')
