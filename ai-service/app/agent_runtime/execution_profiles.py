"""Resolve acceptance toolchains without changing a frozen completion contract."""
from copy import deepcopy
from ..repository_toolchains import verification_profile
from .workspace import safe_path


def prepare(root, commands, arguments):
    prepared, requirements, profiles = [], [], {}
    for original in commands:
        command = deepcopy(original)
        # Completion checks already contain their frozen execution environment.
        # Explicit caller choices also override discovery for repository tests.
        if 'image' not in command and not arguments.get('image'):
            relative = command.get('root', '.')
            if relative not in profiles:
                directory = root if relative == '.' else safe_path(root, relative)
                profiles[relative] = verification_profile(directory)
            profile = profiles[relative]
            if profile['issues'] or not profile['image']:
                if not any(item['root'] == relative for item in requirements):
                    requirements.append({'kind':'toolchain','root':relative,
                        'description':'; '.join(profile['issues']) or 'No unambiguous Linux acceptance toolchain'})
            else:
                command['image'] = profile['image']
                command['setup'] = arguments['setup'] if 'setup' in arguments else profile['setup']
                command['network'] = arguments['network'] if 'network' in arguments else profile['network']
        prepared.append(command)
    return prepared, requirements
