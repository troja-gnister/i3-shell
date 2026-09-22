#!/usr/bin/env bash
# Retained Phase 1 native acceptance, run only through nested.sh.
set -euo pipefail
export PYTHONPATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)${PYTHONPATH:+:$PYTHONPATH}"
python3 - <<'PY'
import json
import os
from pathlib import Path
import time
from client import call, command, fixture, isolated, state, tree, wait_until, windows

isolated()

def check(label, actual, expected):
    assert actual == expected, f'{label}: got {actual!r}, want {expected!r}'
    print(f'ok {label}: {actual!r}', flush=True)


def run(text):
    ok, message = command(text)
    assert ok, (text, message)
    return message


def press(key):
    assert call('org.i3shell.Debug', 'PressKey', '(s)', (key,))[0], key
    # Delivery is asynchronous; callers wait for observable resulting state.
    time.sleep(0.15)


def at_workspace(index):
    wait_until(lambda: state()['activeWorkspace'] == index, f'workspace {index + 1}')
    check('active workspace', state()['activeWorkspace'], index)


def mode(name, count):
    wait_until(lambda: state()['mode'] == name and state()['grabbed'] == count,
               f'{name} mode with {count} grabs')
    check('mode / grabs', (state()['mode'], state()['grabbed']), (name, count))


NAMES = ['1:I', '2:II', '3:III', '4:IV', '5:V', '6:VI', '7:VII', '8:VIII', '9:IX', '10:X']

def pills(active, occupied):
    want = [dict(name=name, active=i == active, occupied=i in occupied) for i, name in enumerate(NAMES)]
    wait_until(lambda: state()['pills'] == want, 'A2 pill names/active/occupied')
    check('A2 pills', state()['pills'], want)


# Startup action mode and key grabs settle independently; collision retries are
# 500 ms, 1.5 s, 4 s. Keep the reference configuration's exact counts.
wait_until(lambda: state()['ready'], 'ready', timeout=20)
mode('default', 65)
config = json.loads(call('org.i3shell.Control', 'GetConfigStatus')[0])
check('config source', config['source'], 'file')
check('config errors', config['errors'], 0)
check('state config source', state()['configSource'], 'file')
check('workspace count', state()['workspaceCount'], 10)
check('A1 begins without fixture windows', windows(), [])

run('workspace number 3'); at_workspace(2)
press('<Super>4'); at_workspace(3)
press('<Super>0'); at_workspace(9)
press('<Super>1'); at_workspace(0)
assert 'no focused window' in run('move container to workspace number 5')
print('ok A1 empty move reports no focused window', flush=True)
press('<Super><Shift>5'); at_workspace(0)
pills(0, set())

marker = Path(os.environ['I3SHELL_SANDBOX']) / 'exec-ok'
run(f'exec touch {marker}')
wait_until(marker.is_file, 'A3 real exec marker')
print('ok A3 exec creates marker', flush=True)

try:
    # Leave the initially empty Shell overview so Entry focus is real.
    press('Escape')
    wait_until(lambda: state()['actionMode'] == 1, 'Shell NORMAL action mode')
    for name in ['Tile A', 'Tile B']:
        assert fixture('Create', '(sss)', (name, 'normal', ''))[0]
        wait_until(lambda: any(w['title'] == name for w in windows()), name + ' first frame')
    wait_until(lambda: len(windows()) == 2, 'two tiles')
    by_title = {w['title']: w for w in windows()}
    monitor = by_title['Tile A']['monitor']
    check('same monitor', by_title['Tile B']['monitor'], monitor)
    area = next(m['workArea'] for ws in tree()['workspaces'] if ws['index'] == 0
                for m in ws['monitors'] if m['id'] == monitor)
    x, y, width, height = (area[k] for k in ['x', 'y', 'width', 'height'])

    def expected(left_width):
        return {'Tile A': dict(x=x, y=y, width=left_width, height=height),
                'Tile B': dict(x=x + left_width, y=y, width=width-left_width, height=height)}

    def frames(want):
        wait_until(lambda: {w['title']: w['rect'] for w in windows()} == want,
                   'actual native frames ' + repr(want))
        check('A4 actual native frames', {w['title']: w['rect'] for w in windows()}, want)

    frames(expected((width + 1) // 2))
    pills(0, {0})
    assert fixture('Action', '(ss)', ('Tile B', 'present'))[0]
    def second_selected():
        ws = next(ws for ws in tree()['workspaces'] if ws['index'] == 0)
        root = next(m['root'] for m in ws['monitors'] if m['id'] == monitor)
        leaf = next(c for c in root['children'] if c.get('window') == by_title['Tile B']['id'])
        return ws['selected'] == {'kind': 'tiled', 'nodeId': leaf['id']}
    wait_until(second_selected, 'second tile selected')
    press('<Super>r'); mode('resize', 11)
    press('j')
    frames(expected((width * 6 + 5) // 10))
    mode('resize', 11)
    for name in ['Tile A', 'Tile B']:
        check('A4 resize key not typed into ' + name, fixture('Text', '(s)', (name,))[0], '')
    press('Escape'); mode('default', 65)
    press('<Super>r'); mode('resize', 11)
    press('Return'); mode('default', 65)
    press('<Super>r'); mode('resize', 11)
    press('<Super>r'); mode('default', 65)
except Exception:
    print('A4 failure state:', json.dumps(state()), flush=True)
    print('A4 failure tree:', json.dumps(tree()), flush=True)
    print('A4 failure windows:', json.dumps(windows()), flush=True)
    raise
finally:
    fixture('Reset')
wait_until(lambda: not windows(), 'fixture teardown')
pills(0, set())

press('<Super>r'); mode('resize', 11)
call('org.i3shell.Debug', 'SimulateSessionMode', '(b)', (True,))
mode('default', 0)
call('org.i3shell.Debug', 'SimulateSessionMode', '(b)', (False,))
mode('default', 65)
press('<Super>2'); at_workspace(1)
pills(1, set())

cfg = Path(os.environ['XDG_CONFIG_HOME']) / 'i3/config'
original = cfg.read_text()
try:
    cfg.write_text(original + '\nbogus_directive 1\n')
    assert 'rejected' in run('reload')
    mode('default', 65)
    press('<Super>3'); at_workspace(2)
    check('config source after rejection', state()['configSource'], 'file')
    cfg.unlink()
    assert 'rejected' in run('reload')
    mode('default', 65)
    press('<Super>4'); at_workspace(3)
    check('config source after missing-file rejection', state()['configSource'], 'file')
    print('ok A5 invalid and missing-file reload rejected; bindings retained', flush=True)
    cfg.write_text(original + '\nbindsym Mod4+F9 workspace number 5\n')
    assert 'reloaded' in run('reload')
    mode('default', 66)
    press('<Super>F9'); at_workspace(4)
    pills(4, set())
finally:
    cfg.write_text(original)
    assert 'reloaded' in run('reload')
mode('default', 65)
check('restored config source', state()['configSource'], 'file')
print('ok Phase 1 native acceptance: A1, A2, A3, A4, A5, A7', flush=True)
PY
