"""Walk GameObject::customSetup, EnhancedGameObject::customSetup and
GameObject::setupCustomSprites in the 2.206 IDA decompile
(data/ref/gd-ida-decomp.cpp) once per object id and record which of a few
render flags each id ends up with.

    python tools/ref-trace-ida-customsetup.py > data/ref/customSetup_render_flags_2206.json

Both functions are one decision tree on the object id with shared labels, so
they are interpreted rather than read by eye: the id is the only input, every
other member starts at 0 (the object is fresh, and not in the editor), and a
condition this script cannot evaluate is reported and taken as false.

Recorded, by byte offset:
  +824  pulses to the music, which keeps it out of the enter scale effects
  +889  skips the default enter fade (PlayLayer::updateVisibility :96043-96050)
  +892  ... unless the object blends
  +928  an invisible block (updateVisibility :96022-96028 -> updateInvisibleBlock)
  +929  its glow takes the background every frame, not its own colour
        (setObjectColor :165358-165364; updateVisibility :96010-96018); the
        rings set it in RingObject::init (:308156-308167), which this does
        not walk
  +930  ... the light background rather than the background's tint
  +855  hidden in play: !+549, the editor flag, so 1 here (activateObject
        :169451-169475 never turns it on)
  +1040 a custom texture rect: getObjectTextureRect never sets the fade lead
        +704 (:165040-165047)
  +1041 a custom size at +1044 for that rect (:165050-165052)
  +1198 an animated object (EnhancedGameObject)
  +1199 a rotating object, and `rotate`, the base speed createRotateAction is
        given, with R for a rand() roll
  +552  its colour sprite never leaves the object for a batch of its own
        (addColorSpriteToParent :169340-169420 does nothing)
  +656  its sprites go in its layer's node container (getParentMode 4)
  +908  its sprites go in GJ_GameSheet02's batches (getParentMode 1)
  +909  its colour sprite sits in front of it (addColorSpriteToSelf
        :168641-168670) and is the half moved up a layer when the halves
        blend differently (addMainSpriteToParent :169272-169338)
        commonInteractiveSetup (:171250-171262) sets +552 and +909; it is
        called, not walked, so its calls are recorded as if inline
  +471  CCSprite's don't-draw flag on the object's own sprite, and on the
        sprites a call just made (`dontDraw:<call>`). setupCustomSprites is
        nine thousand lines with loops and two hundred conditions this script
        cannot read, so these two are a lead to check, not a table to ship.

The renderer's lists (render/drawList.ts INVISIBLE_IDS, FADE_EXEMPT_IDS,
HIDDEN_IN_PLAY_IDS, CUSTOM_RECT_IDS, rotationBase, AUDIO_SCALE_IDS,
GLOW_BG_IDS) and render/batchNodes.ts (CONTAINER_IDS, GAME_SHEET_02_IDS)
were read off this output, and the asset build's don't-draw
lists (tools/assets/objects.ts COLOUR_SPRITE_HIDDEN_IDS,
MAIN_SPRITE_HIDDEN_IDS) off the +471 leads, each checked at its site.
"""
import json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'data', 'ref', 'gd-ida-decomp.cpp')
lines = open(SRC, encoding='utf-8', errors='replace').read().split('\n')

def body_of(signature):
    start = next(i for i, l in enumerate(lines) if l.startswith(signature))
    end = start
    while lines[end] != '}':
        end += 1
    # Declarations first (IDA's `// r3` register notes stripped), then code.
    text = '\n'.join(re.sub(r'//.*$', '', l) for l in lines[start:end + 1])
    return text[text.index('{') + 1:text.rindex('}')]

# ---- tokens ---------------------------------------------------------------------
def tokenize(text):
    out = []
    i, n = 0, len(text)
    def skip_ws(i):
        while i < n and text[i] in ' \t\r\n':
            i += 1
        return i
    while True:
        i = skip_ws(i)
        if i >= n:
            return out
        c = text[i]
        if c in '{}':
            out.append(c); i += 1; continue
        m = re.compile(r'(if|switch|while|for)\s*\(').match(text, i)
        if m:
            j = text.index('(', i); depth = 0; k = j
            while True:
                if text[k] == '(': depth += 1
                elif text[k] == ')':
                    depth -= 1
                    if depth == 0: break
                k += 1
            kind = {'if': 'IF', 'switch': 'SWITCH'}.get(m.group(1), 'LOOP')
            if kind == 'LOOP' and text[k + 1:].lstrip().startswith(';'):
                # the `while ( … );` that closes a do-loop
                i = text.index(';', k) + 1; continue
            out.append((kind, text[j + 1:k].strip())); i = k + 1; continue
        m = re.compile(r'do\b').match(text, i)
        if m:
            out.append(('LOOP', 'do')); i = m.end(); continue
        m = re.compile(r'case (-?\d+):').match(text, i)
        if m:
            out.append(('CASE', int(m.group(1)))); i = m.end(); continue
        m = re.compile(r'default:').match(text, i)
        if m:
            out.append(('CASE', None)); i = m.end(); continue
        m = re.compile(r'else\b').match(text, i)
        if m:
            out.append(('ELSE',)); i = m.end(); continue
        m = re.compile(r'(LABEL_\d+):').match(text, i)
        if m:
            out.append(('LABEL', m.group(1))); i = m.end(); continue
        # a statement: up to the ';' at paren depth 0
        depth = 0; k = i
        while True:
            ch = text[k]
            if ch == '(': depth += 1
            elif ch == ')': depth -= 1
            elif ch == ';' and depth == 0: break
            elif ch == '"':
                k = text.index('"', k + 1)
            k += 1
        out.append(('STMT', ' '.join(text[i:k].split()))); i = k + 1

# ---- tree -----------------------------------------------------------------------
class Parser:
    def __init__(self, toks):
        self.t = toks; self.p = 0
    def block(self, closing):
        out = []
        while self.p < len(self.t):
            tok = self.t[self.p]
            if tok == '}':
                self.p += 1
                if closing: return out
                raise SyntaxError('stray }')
            out.extend(self.one())
        if closing: raise SyntaxError('unterminated block')
        return out
    def one(self):
        tok = self.t[self.p]
        if tok == '{':
            self.p += 1
            return self.block(True)
        if tok[0] == 'LABEL':
            self.p += 1
            return [('label', tok[1])] + self.one()
        if tok[0] == 'CASE':
            self.p += 1
            return [('case', tok[1])]
        if tok[0] == 'SWITCH':
            self.p += 1
            return [('switch', tok[1], self.one())]
        if tok[0] == 'LOOP':
            self.p += 1
            return [('loop', tok[1], self.one())]
        if tok[0] == 'IF':
            self.p += 1
            then = self.one()
            other = None
            if self.p < len(self.t) and self.t[self.p] != '}' and self.t[self.p][0] == 'ELSE':
                self.p += 1
                other = self.one()
            return [('if', tok[1], then, other)]
        self.p += 1
        return [('stmt', tok[1])]

def build(signature):
    tree = Parser(tokenize(body_of(signature))).block(False)
    paths = {}
    def index(block, path):
        for i, node in enumerate(block):
            if node[0] == 'label':
                paths[node[1]] = path + [(block, i)]
            elif node[0] == 'if':
                index(node[2], path + [(block, i)])
                if node[3] is not None: index(node[3], path + [(block, i)])
            elif node[0] in ('switch', 'loop'):
                index(node[2], path + [(block, i)])
    index(tree, [])
    return tree, paths

# ---- evaluation -----------------------------------------------------------------
unknown = set()

ELF_FIELD = {'st_name': 0, 'st_value': 4, 'st_size': 8, 'st_info': 12, 'st_other': 13, 'st_shndx': 14}

def address(m):
    base = int(m.group(2), 16) + (ELF_FIELD[m.group(3)] if m.group(3) else 0)
    return str(base + (int(m.group(4)) if m.group(4) else 0))

def c2py(e):
    e = e.replace('(ObjectToolbox *)', '')
    e = re.sub(r'\(\(char \*\)&(stru|dword|byte|word|unk)_([0-9A-F]+)(?:\.(st_\w+))? \+ (\d+)\)', address, e)
    # IDA names a few of these addresses off_ (a pointer it thinks lives
    # there) and writes them without the &: (char *)off_3C + 3 is 63. Left
    # unread, `v4 == 62` went unknown, and every id from 41 to 61 took the
    # branch meant for 62 (:614711-614715), as 197-221 did another's.
    e = re.sub(r'\(\(char \*\)off_([0-9A-F]+) \+ (\d+)\)', lambda m: str(int(m.group(1), 16) + int(m.group(2))), e)
    e = re.sub(r'&(stru|dword|byte|word|unk)_([0-9A-F]+)(?:\.(st_\w+))?()(?![\w\[])', address, e)
    e = re.sub(r'\b(byte|word|dword)_([0-9A-F]+)\[(\d+)\]', lambda m: str(int(m.group(2), 16) + int(m.group(3))), e)
    e = re.sub(r'\*\(\(_DWORD \*\)this \+ (\d+)\)', lambda m: 'M[%d]' % (4 * int(m.group(1))), e)
    e = re.sub(r'\*\(\(float \*\)this \+ (\d+)\)', lambda m: 'M[%d]' % (4 * int(m.group(1))), e)
    e = re.sub(r'\*\(\(_BYTE \*\)this \+ (\d+)\)', lambda m: 'M[%d]' % int(m.group(1)), e)
    e = re.sub(r'\*\(\(unsigned __int8 \*\)this \+ (\d+)\)', lambda m: 'M[%d]' % int(m.group(1)), e)
    e = re.sub(r'\(unsigned int\)\s*\(([^()]*)\)', r'((\1) & 0xffffffff)', e)
    e = re.sub(r'\(unsigned int\)\s*([A-Za-z_]\w*)', r'((\1) & 0xffffffff)', e)
    e = re.sub(r'\((?:int|float|unsigned __int8|_BYTE|_DWORD|__int16|char \*)\)', '', e)
    e = re.sub(r'\b(0x[0-9A-Fa-f]+|\d+)u\b', r'\1', e)
    e = e.replace('&&', ' and ').replace('||', ' or ')
    e = re.sub(r'!(?!=)', ' not ', e)
    return e

def evaluate(expr, env):
    try:
        return eval(c2py(expr), {}, env)
    except Exception:
        unknown.add(expr)
        return None

def symbolic(text, env):
    """An expression with the locals it names filled in: rand()/2^31 as R,
    a float passed by its bits as the float."""
    t = re.sub(r'\*\(float \*\)&(v\d+)', lambda m: repr(struct.unpack('<f', struct.pack('<I', env[m.group(1)] & 0xffffffff))[0])
               if isinstance(env.get(m.group(1)), int) else m.group(0), text)
    def local(m):
        v = env.get(m.group(0))
        if isinstance(v, tuple): return '(' + v[1] + ')'
        if isinstance(v, (int, float)): return repr(v)
        return m.group(0)
    t = re.sub(r'\bv\d+\b', local, t)
    t = re.sub(r'vcvts_n_f32_s32\((?:rand\(\)|\(rand\(\)\)|R), 0x1Fu\)', 'R', t)
    t = re.sub(r'\(float\)rand\(\) \* 4\.6566e-10', 'R', t)
    t = t.replace('(float)', '').replace('rand()', 'R')
    return ' '.join(t.split())

class Break(Exception): pass
class Goto(Exception):
    def __init__(self, label): self.label = label
class Return(Exception): pass

class Env(dict):
    def __missing__(self, k):
        if k == 'M': return self.setdefault('M', Mem())
        raise NameError(k)
class Mem(dict):
    def __missing__(self, k): return 0

def run(tree, paths, oid, record, unsigned, hook=None):
    """`hook(s, env, record)`, when given, sees every statement first and
    returns True for one it has handled (tools/ref-trace-ida-particles.py)."""
    env = Env()
    env['M'] = Mem({884: oid})
    made_by = {}
    def stmt(s):
        if hook is not None and hook(s, env, record):
            return
        if s.startswith('goto '):
            raise Goto(s[5:].strip())
        if s.startswith('return'):
            raise Return()
        if s == 'break':
            raise Break()
        m = re.match(r'^\*\(\((_BYTE|_DWORD|float) \*\)this \+ (\d+)\) = (.*)$', s)
        if m:
            off = int(m.group(2)) * (1 if m.group(1) == '_BYTE' else 4)
            v = evaluate(m.group(3), env)
            env['M'][off] = v if v is not None else m.group(3)
            record(off, env['M'][off])
            return
        m = re.match(r'^\*\(_BYTE \*\)\((v\d+) \+ 471\) = 1$', s)
        if m:
            made = made_by.get(m.group(1), '?')
            record('dontDraw:' + made, 1)
            return
        m = re.match(r'^(v\d+) = (?:\([^()]*\))?(GameObject::\w+)\(', s)
        if m:
            made_by[m.group(1)] = m.group(2)
        m = re.match(r'^(v\d+) = (.*)$', s)
        if m:
            v = evaluate(m.group(2), env)
            if isinstance(v, (int, bool)) and not isinstance(v, bool) and m.group(1) in unsigned:
                v &= 0xffffffff  # an unsigned int local wraps
            env[m.group(1)] = v if v is not None else ('?', symbolic(m.group(2), env))
            return
        m = re.match(r'^EnhancedGameObject::createRotateAction\(\(int\)(?:this|v21), (.*), (.*)\)$', s)
        if m:
            record('rotate', symbolic(m.group(1), env))
            return
    def cond(c):
        v = evaluate(c, env)
        if v is None or isinstance(v, tuple):
            unknown.add(c)
            return False
        return bool(v)
    def block(nodes, start):
        for node in nodes[start:]:
            if node[0] == 'stmt': stmt(node[1])
            elif node[0] == 'if':
                if cond(node[1]): block(node[2], 0)
                elif node[3] is not None: block(node[3], 0)
            elif node[0] == 'loop':
                pass
            elif node[0] == 'switch':
                v = evaluate(node[1], env)
                body = node[2]
                at = next((i for i, x in enumerate(body) if x[0] == 'case' and x[1] == v), None)
                if at is None: at = next((i for i, x in enumerate(body) if x[0] == 'case' and x[1] is None), None)
                if at is not None:
                    try: block(body, at + 1)
                    except Break: pass
    path = [(tree, 0)]
    for _ in range(500):
        try:
            level = len(path) - 1
            try:
                block(path[-1][0], path[-1][1])
            except Break:
                # out of the innermost switch on the path
                while level > 0 and path[level - 1][0][path[level - 1][1]][0] != 'switch':
                    level -= 1
                level -= 1
            for (outer, i) in reversed(path[:level]):
                block(outer, i + 1)
            return
        except Goto as g:
            path = paths[g.label]
        except Return:
            return
    raise RuntimeError('loop at %d' % oid)

def unsigned_locals(signature):
    """The locals IDA declares `unsigned int`: arithmetic on them wraps."""
    body = body_of(signature)
    return set(re.findall(r'unsigned int (v\d+);', body))

def trace(signature, ids, keep, hook=None):
    tree, paths = build(signature)
    unsigned = unsigned_locals(signature)
    out = {}
    for oid in ids:
        seen = {}
        def record(k, v):
            if k in keep: seen[str(k)] = v
        run(tree, paths, oid, record, unsigned, hook)
        if seen: out[oid] = seen
    return out

def interactive(s, env, record):
    """GameObject::commonInteractiveSetup, inline: the two flags it sets that
    the renderer reads. [:171250-171262]"""
    if s.startswith('GameObject::commonInteractiveSetup('):
        record(552, 1)
        record(909, 1)
        return True
    return False

if __name__ == '__main__':
    ids = range(1, 4540)
    base = trace('_DWORD *__fastcall GameObject::customSetup(GameObject *this)', ids,
                 {552, 656, 824, 825, 855, 889, 892, 908, 909, 928, 929, 930, 1040, 1041}, interactive)
    enhanced = trace('_DWORD *__fastcall EnhancedGameObject::customSetup(EnhancedGameObject *this)', ids,
                     {552, 656, 824, 825, 855, 908, 909, 928, 929, 930, 1040, 1041, 1198, 1199, 'rotate'}, interactive)
    sprites = trace('int __fastcall GameObject::setupCustomSprites(GameObject *this, const char *a2)', ids,
                    {471, 552, 909, 1040, 1041, 'dontDraw:GameObject::addCustomColorChild', 'dontDraw:GameObject::addCustomChild',
                     'dontDraw:GameObject::addInternalCustomColorChild', 'dontDraw:GameObject::addInternalChild'}, interactive)
    merged = {}
    for src in (base, enhanced, sprites):
        for oid, rec in src.items():
            merged.setdefault(oid, {}).update(rec)
    json.dump({str(k): v for k, v in sorted(merged.items())}, sys.stdout, indent=0)
    print(file=sys.stderr)
    print('unknown conditions:', len(unknown), file=sys.stderr)
    for u in sorted(unknown)[:40]: print('  ', u[:150], file=sys.stderr)
