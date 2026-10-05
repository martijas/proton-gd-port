"""Walk GameObject::setupCustomSprites in the 2.206 IDA decompile once per
object id, as tools/ref-trace-ida-customsetup.py does, and record which
sprites have their top corners lowered.

    python tools/ref-trace-ida-trims.py > data/ref/customSetup_trims_2206.json

RobTop's CCSprite carries four floats at +476, +480, +484 and +488 that
lower its top-left and top-right corners and raise its bottom-left and
bottom-right ones by that share of its height, cropping the texture with
them (setTextureCoords :862782-862827, updateTransform :864290-864367;
refreshTextureRect :862250 notes any of them is set). setupCustomSprites is
the only place that sets them, and only the top two: the slope pieces of the
block sets cut two square tiles into a slope this way.

For each id the output lists the sprites a trim was written on: the object's
own sprite ("main"), its colour sprite (+748, "colour"), or one an add call
just made, with the call, the frame it was made from and where it was put.
"""
import importlib.util, json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('customsetup', os.path.join(HERE, 'ref-trace-ida-customsetup.py'))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

CORNERS = {119: 0, 120: 1}

def as_float(v):
    """A trim is written as the float's bits, or as a float local."""
    if isinstance(v, bool) or v is None or isinstance(v, tuple):
        return None
    if isinstance(v, int):
        return round(struct.unpack('<f', struct.pack('<I', v & 0xffffffff))[0], 6)
    if isinstance(v, float):
        return round(v, 6)
    return None

def colour_frame(name):
    """GameObject::getColorFrame: the frame's `_color_` twin."""
    return re.sub(r'_001\.png$', '_color_001.png', name) if name else None

def make_hook(state):
    strings, points, sprites = state['strings'], state['points'], state['sprites']

    def text(arg, env):
        arg = arg.strip()
        m = re.fullmatch(r'"([^"]*)"', arg)
        if m: return m.group(1)
        m = re.fullmatch(r'(?:\([^()]*\))?&?(v\d+)', arg)
        if m:
            name = m.group(1)
            if name in strings: return strings[name]
            v = env.get(name)
            return v if isinstance(v, str) else None
        if arg == 'a2': return '<own frame>'
        return None

    def sprite_at(var):
        return sprites.get(var)

    def trim(target, corner, value, env):
        v = as_float(cs.evaluate(value, env))
        if v is None:
            state['unread'].add(value)
            return
        target.setdefault('cut', [0, 0])[CORNERS[corner]] = v

    def hook(s, env, record):
        m = re.match(r'^sub_75309C\((?:\(\w+ \*\))?&?(v\d+), (.+?), [^,]+\)$', s)
        if m:
            strings[m.group(1)] = text(m.group(2), env)
            return True
        m = re.match(r'^sub_751EEC\(\(int\)&(v\d+), (.+)\)$', s)
        if m:
            strings[m.group(1)] = text(m.group(2), env)
            return True
        m = re.match(r'^sub_752738\(&?(v\d+), (.+)\)$', s)
        if m:
            strings[m.group(1)] = text(m.group(2), env)
            return True
        m = re.match(r'^GameObject::getColorFrame\(&?(v\d+), \(int\)this, \(char \*\)&?(v\d+), \w+\)$', s)
        if m:
            strings[m.group(1)] = colour_frame(strings.get(m.group(2)))
            return True
        m = re.match(r'^cocos2d::CCPoint::CCPoint\(\(cocos2d::CCPoint \*\)(v\d+), (-?[\d.]+), (-?[\d.]+)\)$', s)
        if m:
            points[m.group(1)] = (float(m.group(2)), float(m.group(3)))
            return True
        m = re.match(r'^cocos2d::CCPoint::CCPoint\(\(cocos2d::CCPoint \*\)(v\d+), \(const cocos2d::CCPoint \*\)&unk_A9D4C8\)$', s)
        if m:
            points[m.group(1)] = (0.0, 0.0)
            return True
        m = re.match(r'^(v\d+) = (?:\([^()]*\))?GameObject::(addCustomChild|addCustomColorChild|addInternalCustomColorChild|addInternalChild|addCustomBlackChild)\((.*)\)$', s)
        if m:
            args = [a.strip() for a in m.group(3).split(',')]
            frame = text(args[1], env) if len(args) > 1 else None
            at = points.get(re.sub(r'^\(int\)', '', args[2])) if len(args) > 2 else (0.0, 0.0)
            rec = {'call': m.group(2), 'f': frame, 'x': at[0] if at else None, 'y': at[1] if at else None}
            state['made'].append(rec)
            sprites[m.group(1)] = rec
            env[m.group(1)] = 1
            return True
        m = re.match(r'^(v\d+) = (?:\([^()]*\))?\*\(\(_DWORD \*\)this \+ 187\)$', s)
        if m:
            sprites[m.group(1)] = state['colour']
            env[m.group(1)] = 1
            return True
        m = re.match(r'^(v\d+)\[(119|120)\] = (.+)$', s) or re.match(r'^\*\(\((?:_DWORD|float) \*\)(v\d+) \+ (119|120)\) = (.+)$', s)
        if m:
            target = sprite_at(m.group(1))
            if target is None:
                state['unread'].add(s)
            else:
                trim(target, int(m.group(2)), m.group(3), env)
            return True
        m = re.match(r'^\*\(\((?:_DWORD|float) \*\)this \+ (119|120)\) = (.+)$', s)
        if m:
            trim(state['main'], int(m.group(1)), m.group(2), env)
            return True
        return False

    return hook

if __name__ == '__main__':
    signature = 'int __fastcall GameObject::setupCustomSprites(GameObject *this, const char *a2)'
    tree, paths = cs.build(signature)
    unsigned = cs.unsigned_locals(signature)
    out = {}
    unread = set()
    for oid in range(1, 4540):
        state = {'strings': {}, 'points': {}, 'sprites': {}, 'made': [], 'main': {}, 'colour': {}, 'unread': unread}
        cs.run(tree, paths, oid, lambda k, v: None, unsigned, make_hook(state))
        rec = {}
        if 'cut' in state['main']: rec['main'] = state['main']['cut']
        if 'cut' in state['colour']: rec['colour'] = state['colour']['cut']
        cut = [m for m in state['made'] if 'cut' in m]
        if cut: rec['sprites'] = cut
        if rec: out[str(oid)] = rec
    json.dump(out, sys.stdout, indent=0)
    print(file=sys.stderr)
    print('ids with a trim:', len(out), file=sys.stderr)
    print('unread:', len(unread), file=sys.stderr)
    for u in sorted(unread)[:20]: print('  ', u[:150], file=sys.stderr)
