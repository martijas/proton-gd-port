"""Interpret the Ghidra pseudo-C of GameObject::customSetup() (GD 2.206 Android,
from CallocGD/ehekufa GD-2.206-Decompiled src/Common/GameObject.cpp, commented-out
block) for every object id 1..4539 and record the resulting m_objectType etc.

v2: handles Ghidra register temporaries that were (mis)named m_objectID / m_objectType.
"""
import re, sys, json, os

# The Ghidra pseudo-C this reads, from CallocGD/GD-2.206-Decompiled
# (src/Common/GameObject.cpp). Kept in data/ref/ with the other reference
# inputs; override with GD_DECOMP to point somewhere else.
SRC = os.environ.get('GD_DECOMP') or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'ref', 'GameObject.cpp')
lines = open(SRC, encoding='utf-8', errors='replace').read().split('\n')

start = None
for i, l in enumerate(lines):
    if l.startswith('// void GameObject::customSetup()'):
        start = i
        break
assert start is not None
body = []
i = start + 1
while True:
    l = lines[i]
    if l.startswith('//'):
        body.append(l[2:])
    elif l.strip() == '':
        body.append('')
    else:
        break
    i += 1
txt = '\n'.join(body)
first = txt.index('{')
last = txt.rindex('}')
txt = txt[first + 1:last]

# ---- tokenize -----------------------------------------------------------------
raw = [l.strip() for l in txt.split('\n')]
stmts = []
buf = ''
for l in raw:
    if not l:
        continue
    buf = (buf + ' ' + l).strip() if buf else l
    if buf.count('(') > buf.count(')'):
        continue
    stmts.append(buf)
    buf = ''
if buf:
    stmts.append(buf)

tokens = []
for s in stmts:
    while s:
        s = s.strip()
        if not s:
            break
        if s.startswith('}'):
            tokens.append('}')
            s = s[1:]
            continue
        if s.startswith('else if'):
            m = re.match(r'else if \((.*)\)\s*(\{)?$', s)
            if m and m.group(2):
                tokens.append(('ELSEIF', m.group(1), True)); s = ''
            else:
                m2 = re.match(r'else if \((.*?)\)\s+(.*;)$', s)
                if m2:
                    tokens.append(('ELSEIF', m2.group(1), False)); tokens.append(m2.group(2)); s = ''
                else:
                    m3 = re.match(r'else if \((.*)\)$', s)
                    assert m3, s
                    tokens.append(('ELSEIF', m3.group(1), False)); s = ''
            continue
        if s.startswith('else'):
            rest = s[4:].strip()
            if rest.startswith('{'):
                tokens.append(('ELSE', True)); s = rest[1:]
            else:
                tokens.append(('ELSE', False)); s = rest
            continue
        if s.startswith('if'):
            depth = 0; j = s.index('(')
            k = j
            while True:
                if s[k] == '(': depth += 1
                elif s[k] == ')':
                    depth -= 1
                    if depth == 0: break
                k += 1
            cond = s[j + 1:k]
            rest = s[k + 1:].strip()
            if rest.startswith('{'):
                tokens.append(('IF', cond, True)); s = rest[1:]
            else:
                tokens.append(('IF', cond, False)); s = rest
            continue
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$', s)
        if m and not s.startswith('cocos2d::') and '::' not in m.group(1):
            tokens.append(('LABEL', m.group(1))); s = m.group(2)
            continue
        if s.endswith('{'):
            tokens.append(s[:-1].strip()); tokens.append('{'); s = ''
            continue
        if ';' in s:
            idx = s.index(';')
            tokens.append(s[:idx + 1]); s = s[idx + 1:]
        else:
            tokens.append(s); s = ''

# ---- AST ----------------------------------------------------------------------
pos = 0
_stmt_counter = [0]
label_index = {}
def next_idx():
    _stmt_counter[0] += 1
    return _stmt_counter[0]

def parse_block(until_close):
    global pos
    block = []
    while pos < len(tokens):
        t = tokens[pos]
        if t == '}':
            if until_close:
                pos += 1
                return block
            raise RuntimeError('unexpected }')
        if isinstance(t, tuple) and t[0] == 'IF':
            block.extend(parse_if())
            continue
        if isinstance(t, tuple) and t[0] == 'LABEL':
            pos += 1
            block.append(('label', t[1]))
            label_index[t[1]] = _stmt_counter[0]
            continue
        if t == '{':
            pos += 1
            block.extend(parse_block(True))
            continue
        pos += 1
        block.append(('stmt', t, next_idx()))
    if until_close:
        raise RuntimeError('unterminated block')
    return block

def parse_single():
    global pos
    t = tokens[pos]
    if isinstance(t, tuple) and t[0] == 'IF':
        return parse_if()
    if isinstance(t, tuple) and t[0] == 'LABEL':
        pos += 1
        label_index[t[1]] = _stmt_counter[0]
        return [('label', t[1])] + parse_single()
    pos += 1
    return [('stmt', t, next_idx())]

def parse_if():
    global pos
    t = tokens[pos]; pos += 1
    branches = []
    blk = parse_block(True) if t[2] else parse_single()
    branches.append((t[1], blk))
    else_blk = None
    while pos < len(tokens) and isinstance(tokens[pos], tuple) and tokens[pos][0] in ('ELSEIF', 'ELSE'):
        e = tokens[pos]; pos += 1
        if e[0] == 'ELSEIF':
            blk = parse_block(True) if e[2] else parse_single()
            branches.append((e[1], blk))
        else:
            else_blk = parse_block(True) if e[1] else parse_single()
            break
    return [('if', branches, else_blk)]

ast = parse_block(False)
TAIL_START = label_index['LAB_003677a4']

label_paths = {}
def index_labels(block, path):
    for i, node in enumerate(block):
        if node[0] == 'label':
            label_paths[node[1]] = path + [(block, i)]
        elif node[0] == 'if':
            for cond, blk in node[1]:
                index_labels(blk, path + [(block, i)])
            if node[2] is not None:
                index_labels(node[2], path + [(block, i)])
index_labels(ast, [])

# ---- expressions ---------------------------------------------------------------
def c2py(expr):
    e = expr
    e = re.sub(r'\(unsigned int\)\s*\(([^()]*)\)', r'((\1) & 0xffffffff)', e)
    e = re.sub(r'\(unsigned int\)\s*([A-Za-z_][A-Za-z0-9_]*)', r'((\1) & 0xffffffff)', e)
    e = re.sub(r'\((CCParticleSystemQuad|code|undefined4|undefined|float|int|bool|byte|char|uint|short|ushort)\s*\*?\)', '', e)
    e = re.sub(r'([A-Za-z_][A-Za-z0-9_]*)\s*-\s*(0x[0-9a-fA-F]+|\d+)U\b', r'((\1 - \2) & 0xffffffff)', e)
    e = re.sub(r'\b(0x[0-9a-fA-F]+|\d+)U\b', r'\1', e)
    e = e.replace('&&', ' and ').replace('||', ' or ')
    e = re.sub(r'!(?!=)', ' not ', e)
    e = e.replace('this->', '').replace('->', '.')
    e = e.replace("'\\x01'", '1')
    e = re.sub(r'\btrue\b', 'True', e)
    e = re.sub(r'\bfalse\b', 'False', e)
    e = re.sub(r'(\w+) < 0 != (\w+)', r'((\1 < 0) != \2)', e)
    e = re.sub(r'\bSBORROW4\([^()]*\)', '0', e)
    e = re.sub(r'\b(rand|lroundf|FixedToFP|shouldLockX|isTrigger|isStoppableTrigger|ignoreEditorDuration|dontCountTowardsLimit|isEditorSpawnableTrigger)\([^()]*\)', '0', e)
    e = re.sub(r'\bcreateAndAddParticle\([^()]*\)', '1', e)
    return e

class Env(dict):
    def __missing__(self, k):
        return 0

TEMPVARS = ('m_objectID', 'm_objectType')
FLAGS = ('flag_a', 'bVar14', 'uVar9', 'iVar8')

def view(env):
    v = Env(env)
    for k in TEMPVARS:
        if k in env['__tmp']:
            v[k] = env['__tmp'][k]
    return v

def expire(env, text):
    names = set(re.findall(r'[A-Za-z_][A-Za-z0-9_]*', text))
    words = {n for n in names if not re.match(r'^(0x|\d)', n)}
    neutral = bool(words) and all(n in FLAGS or n in ('not', 'and', 'or') for n in words)
    for k in list(env['__tmp'].keys()):
        if k in names or neutral:
            continue
        del env['__tmp'][k]

unknown_conds = set()
ignored_stmts = set()

def eval_cond(cond, env):
    try:
        r = bool(eval(c2py(cond), {}, view(env)))
    except Exception:
        unknown_conds.add(cond)
        r = False
    expire(env, cond)
    return r

class Goto(Exception):
    def __init__(self, label): self.label = label
class Return(Exception): pass

TRACK = ('m_objectType', 'm_width', 'm_height', 'm_objectRadius', 'm_isSolid', 'm_isPassable', 'm_isPortalObject',
         'm_isSpecialObject', 'm_spriteWidthScale', 'm_spriteHeightScale', 'm_defaultZOrder',
         'm_defaultZLayer', 'm_isRotationAligned', 'm_hasNoGlow', 'm_dontFadeTinted', 'm_ignoreEnter',
         'm_shouldUseOuterOb', 'm_hasSepcialChild', 'm_isTintObject', 'm_hasAudioScale', 'm_isSolidColorBlock',
         'm_updateCustomContentSize', 'm_useSpecialLight', 'm_isNoTouch')

def exec_stmt(text, env, sidx=0):
    s = text.strip().rstrip(';').strip()
    if not s:
        return
    if s.startswith('goto '):
        raise Goto(s[5:].strip())
    if s == 'return':
        raise Return()
    if s.startswith('commonInteractiveSetup('):
        env['m_objectType'] = 30
        env['__typeSet'] = True
        env['m_defaultZOrder'] = 9
        env['__tmp'].pop('m_objectType', None)
        expire(env, s)
        return
    m = re.match(r'^([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$', s)
    if m and not m.group(2).startswith('='):
        lhs, rhs = m.group(1), m.group(2)
        pyrhs = c2py(rhs)
        try:
            val = eval(pyrhs, {}, view(env))
        except Exception:
            ignored_stmts.add(s)
            expire(env, s)
            return
        is_const = re.fullmatch(r'\s*(0x[0-9a-fA-F]+|\d+|True|False)\s*', pyrhs) is not None
        if lhs == 'm_objectID':
            env['__tmp']['m_objectID'] = val
        elif lhs == 'm_objectType' and not is_const and sidx >= TAIL_START:
            env['__tmp']['m_objectType'] = val
        else:
            env[lhs] = val
            if lhs == 'm_objectType':
                env['__typeSet'] = True
                env['__tmp'].pop('m_objectType', None)
        expire(env, s)
        return
    ignored_stmts.add(s)
    expire(env, s)

def run_block(block, start, env):
    i = start
    while i < len(block):
        node = block[i]
        if node[0] == 'stmt':
            exec_stmt(node[1], env, node[2])
        elif node[0] == 'if':
            taken = False
            for cond, blk in node[1]:
                if eval_cond(cond, env):
                    run_block(blk, 0, env)
                    taken = True
                    break
            if not taken and node[2] is not None:
                run_block(node[2], 0, env)
        i += 1

def run(objid, in_editor=False):
    env = Env()
    env['m_objectID'] = objid
    env['m_objectType'] = 0
    env['m_inLevelEditor'] = in_editor
    env['m_hasNoEffects'] = False
    env['m_isSolid'] = False
    env['m_isPassable'] = False
    env['m_objectRadius'] = 0.0
    env['m_defaultZOrder'] = 0
    env['m_defaultZLayer'] = 5
    env['m_width'] = 0.0
    env['m_height'] = 0.0
    env['this'] = 1
    env['__tmp'] = {}
    path = [(ast, 0)]
    steps = 0
    while True:
        steps += 1
        if steps > 300:
            env['__loop'] = True
            break
        try:
            blk, idx = path[-1]
            run_block(blk, idx, env)
            for (oblk, oidx) in reversed(path[:-1]):
                run_block(oblk, oidx + 1, env)
            break
        except Goto as g:
            if g.label not in label_paths:
                env['__badgoto'] = g.label
                break
            path = label_paths[g.label]
        except Return:
            break
    return env

TYPE_NAMES = {0:'Solid',2:'Hazard',3:'InverseGravityPortal',4:'NormalGravityPortal',5:'ShipPortal',6:'CubePortal',7:'Decoration',8:'YellowJumpPad',9:'PinkJumpPad',10:'GravityPad',11:'YellowJumpRing',12:'PinkJumpRing',13:'GravityRing',14:'InverseMirrorPortal',15:'NormalMirrorPortal',16:'BallPortal',17:'RegularSizePortal',18:'MiniSizePortal',19:'UfoPortal',20:'Modifier',21:'Breakable',22:'SecretCoin',23:'DualPortal',24:'SoloPortal',25:'Slope',26:'WavePortal',27:'RobotPortal',28:'TeleportPortal',29:'GreenRing',30:'Collectible',31:'UserCoin',32:'DropRing',33:'SpiderPortal',34:'RedJumpPad',35:'RedJumpRing',36:'CustomRing',37:'DashRing',38:'GravityDashRing',39:'CollisionObject',40:'Special',41:'SwingPortal',42:'GravityTogglePortal',43:'SpiderOrb',44:'SpiderPad',45:'EnterEffectObject',46:'TeleportOrb',47:'AnimatedHazard'}

if __name__ == '__main__':
    print('statements:', _stmt_counter[0], 'tail starts at stmt', TAIL_START)
    out = {}
    for oid in range(1, 4540):
        env = run(oid)
        rec = {k: env[k] for k in TRACK if k in env}
        rec['typeName'] = TYPE_NAMES.get(rec['m_objectType'], '?')
        rec['typeExplicitlySet'] = bool(env.get('__typeSet'))
        if '__loop' in env: rec['__loop'] = True
        if '__badgoto' in env: rec['__badgoto'] = env['__badgoto']
        out[oid] = rec
    dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'ref', 'customSetup_types_2206.json')
    json.dump(out, open(dest, 'w'), indent=0)
    print('wrote', os.path.normpath(dest))
    from collections import Counter
    c = Counter(r['m_objectType'] for r in out.values())
    print('type histogram:', sorted(c.items()))
    print('ids with type outside enum:', [k for k, r in out.items() if r['m_objectType'] not in TYPE_NAMES][:40])
    print('loops:', sum(1 for r in out.values() if r.get('__loop')), 'badgoto:', sum(1 for r in out.values() if r.get('__badgoto')))
    print('unknown conds:', len(unknown_conds))
    for u in list(unknown_conds)[:10]: print('  COND?', u[:140])
    print('ignored stmts:', len(ignored_stmts))
    for u in sorted(ignored_stmts)[:60]: print('  STMT?', u[:140])
    for t in [1, 5, 8, 88, 289, 468, 476, 507, 641, 647, 869, 1187, 1256, 1933, 10, 11, 12, 13, 35, 36, 67, 84, 140, 141, 142, 1329, 29, 30, 200, 201, 747, 1755, 3005, 1704, 3004, 4539, 143, 1329, 1614, 1613, 1616, 1615, 1859, 1813, 2866, 2069, 3645, 4401, 675, 720, 4412]:
        print(t, out[t])

def trace(objid):
    global eval_cond, exec_stmt
    _ec, _es = eval_cond, exec_stmt
    def ec(cond, env):
        r = _ec(cond, env)
        print('   if (%s) -> %s   [tmp=%s]' % (cond[:110], r, env['__tmp']))
        return r
    def es(text, env, sidx=0):
        s = text.strip()
        if not s.startswith(('memset', 'cocos2d::', '(*', 'pcVar', 'local_', 'pCVar')):
            print('   %s' % s[:110])
        return _es(text, env, sidx)
    eval_cond, exec_stmt = ec, es
    env = run(objid)
    eval_cond, exec_stmt = _ec, _es
    return env
