"""The particle systems GameObject::customSetup, EnhancedGameObject::customSetup
and commonInteractiveSetup hang on an object, per object id, from the 2.206
IDA decompile (data/ref/gd-ida-decomp.cpp):

    python tools/ref-trace-ida-particles.py > data/ref/customSetup_particles_2206.json

Each id that gets one records:
  plist     the effect, from GameObject::createAndAddParticle's third argument
  z         its fourth (the system's z order)
  position  its fifth, the cocos position type (1 relative, 2 grouped), or
            what a later setPositionType (vtable +776) on the system made it
  start, end  the rgba the system's setStartColor (+672) and setEndColor
            (+688) were given, when they were; else the plist's own
  offset    +672 on the object: where the system sits from the object's
            centre, in its own space
  669, 670, 680, 920  the object's switches: take the object's colour (669),
            the colour sprite's rather than the main sprite's (670), keep a
            scale of 1 (680) and a turn of 0 (920) when it claims the system
            (GameObject::claimParticle :167570ff)

Walked with tools/ref-trace-ida-customsetup.py's interpreter, which follows the
id through both functions' decision trees; a hook here reads the statements
that make and colour the system, which that interpreter leaves alone. Only the
first system an object makes is kept: createAndAddParticle stores one key
(+664), so a second would replace the first.
"""
import importlib.util, json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('trace', os.path.join(HERE, 'ref-trace-ida-customsetup.py'))
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)

FLOAT = lambda bits: struct.unpack('<f', struct.pack('<I', bits & 0xffffffff))[0]

def make_hook(found):
    def hook(s, env, record):
        arrs = env.setdefault('__arr', {})
        slots = env.setdefault('__slot', {})
        points = env.setdefault('__pt', {})
        strings = env.setdefault('__str', {})
        m = re.match(r'^(v\d+) = (?:(v\d+) == (\d+) \? )?"([^"]+\.plist)"(?: : "([^"]+\.plist)")?$', s)
        if m:
            # The speed portals pick theirs by id (:180036-180046); a choice
            # between two names is settled by the id it compares.
            if m.group(5):
                same = trace.evaluate(m.group(2), env) == int(m.group(3))
                strings[m.group(1)] = m.group(4) if same else m.group(5)
            else:
                strings[m.group(1)] = m.group(4)
            return True
        m = re.match(r'^(?:(v\d+) = )?(?:\([^()]*\))?GameObject::createAndAddParticle\(\s*this,\s*(.*?),\s*\(int\)(?:"([^"]+)"|(v\d+)),\s*(.*?),\s*(\d+)\)$', s)
        if m:
            plist = m.group(3) or strings.get(m.group(4))
            if 'plist' not in found and plist:
                z = trace.evaluate(m.group(5), env)
                found.update({'plist': plist, 'z': z if isinstance(z, int) else m.group(5), 'position': int(m.group(6))})
            if m.group(1):
                env[m.group(1)] = 1  # the system was made: \`if ( vN )\` holds
            return True
        if s.startswith('GameObject::commonInteractiveSetup('):
            # :171250-171276: the key's effect, unless it is the small coin,
            # at the object's +900 for its z, which is 0 as it is made.
            if env['M'][884] != 1614 and 'plist' not in found:
                found.update({'plist': 'keyEffect.plist', 'z': 0, 'position': 2, 'offset': [0.0, -5.0], '669': 1})
            return False
        m = re.match(r'^(v\d+)\[(\d)\] = (.*)$', s)
        if m:
            v = trace.evaluate(m.group(3), env)
            arrs.setdefault(m.group(1), [0, 0, 0, 0])[int(m.group(2))] = v if isinstance(v, int) else 0
            return True
        m = re.match(r'^memset\((v\d+), .*\)$', s)
        if m:
            arrs[m.group(1)] = [0, 0, 0, 0]
            return True
        m = re.match(r'^(v\d+) = \*\(.*\)\(\*\(_DWORD \*\)(v\d+) \+ (\d+)\)$', s)
        if m:
            slots[m.group(1)] = int(m.group(3))
            return True
        m = re.match(r'^(v\d+)\((v\d+), (v\d+)\)$', s)
        if m and slots.get(m.group(1)) in (672, 688):
            rgba = [round(FLOAT(b), 6) for b in arrs.get(m.group(3), [0, 0, 0, 0])]
            found['start' if slots[m.group(1)] == 672 else 'end'] = rgba
            return True
        m = re.match(r'^\(\*\(.*\)\(\*\(_DWORD \*\)(v\d+) \+ 776\)\)\((v\d+), (\d+)\)$', s)
        if m:
            found['position'] = int(m.group(3))
            return True
        m = re.match(r'^cocos2d::CCPoint::CCPoint\(\(cocos2d::CCPoint \*\)(v\d+), (-?[\d.]+), (-?[\d.]+)\)$', s)
        if m:
            points[m.group(1)] = [float(m.group(2)), float(m.group(3))]
            return True
        m = re.match(r'^cocos2d::CCPoint::operator=\(\(char \*\)this \+ 672, (v\d+)\)$', s)
        if m and m.group(1) in points:
            found['offset'] = points[m.group(1)]
            return True
        return False
    return hook

def particles(signature, ids):
    tree, paths = trace.build(signature)
    unsigned = trace.unsigned_locals(signature)
    out = {}
    keep = {669, 670, 680, 920}
    for oid in ids:
        found = {}
        flags = {}
        def record(k, v):
            if k in keep: flags[str(k)] = v
        trace.run(tree, paths, oid, record, unsigned, make_hook(found))
        if 'plist' in found:
            for k, v in flags.items():
                if v: found[k] = 1
            out[oid] = found
    return out

if __name__ == '__main__':
    ids = range(1, 4540)
    base = particles('_DWORD *__fastcall GameObject::customSetup(GameObject *this)', ids)
    enhanced = particles('_DWORD *__fastcall EnhancedGameObject::customSetup(EnhancedGameObject *this)', ids)
    merged = {}
    for src in (base, enhanced):
        for oid, rec in src.items():
            merged.setdefault(oid, {}).update(rec)
    json.dump({str(k): v for k, v in sorted(merged.items())}, sys.stdout, indent=0)
    print(file=sys.stderr)
    print('objects with a system:', len(merged), file=sys.stderr)
    print('unknown conditions:', len(trace.unknown), file=sys.stderr)
