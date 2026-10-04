"""Create a StackPilot-owned AVD without changing the user's existing devices."""
import json
import os
from pathlib import Path


def prepare(sdk=None, home=None):
    sdk=Path(sdk or os.getenv('ANDROID_HOME') or Path(os.environ['LOCALAPPDATA'])/'Android'/'Sdk').resolve()
    home=Path(home or Path(os.environ['LOCALAPPDATA'])/'StackPilot'/'android-avds').resolve()
    images=sorted(p.parent for p in (sdk/'system-images').glob('*/*/x86_64/source.properties')
                  if (p.parent/'system.img').is_file())
    if not images:raise RuntimeError('Install an x86_64 Android system image in the SDK first')
    image=images[-1];name='stackpilot-local';avd=home/(name+'.avd')
    home.mkdir(parents=True,exist_ok=True);avd.mkdir(exist_ok=True)
    if not (avd/'config.ini').exists():
        values={'AvdId':name,'avd.ini.displayname':'StackPilot isolated Android',
                'abi.type':'x86_64','hw.cpu.arch':'x86_64','hw.cpu.ncore':'2',
                'hw.ramSize':'2048','hw.lcd.width':'720','hw.lcd.height':'1280',
                'hw.lcd.density':'320','hw.keyboard':'yes','hw.gpu.enabled':'yes',
                'hw.gpu.mode':'swiftshader','hw.initialOrientation':'Portrait',
                'disk.dataPartition.size':'2G','showDeviceFrame':'no',
                'image.sysdir.1':image.relative_to(sdk).as_posix()+'/',
                'tag.id':image.parent.name,'tag.display':'Google Play',
                'PlayStore.enabled':'true','fastboot.forceColdBoot':'yes'}
        (avd/'config.ini').write_text(''.join(f'{k}={v}\n' for k,v in values.items()))
    (home/(name+'.ini')).write_text(f'avd.ini.encoding=UTF-8\npath={avd}\ntarget={image.parent.parent.name}\n')
    return {'sdk':str(sdk),'avd_home':str(home),'avd':name,'image':str(image),'serial':'emulator-5580'}


if __name__=='__main__':print(json.dumps(prepare()))
