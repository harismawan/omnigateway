"""Regression test for the actual CLI manifest checker."""
import copy
import json
from dry_run_acceptance import accepted

entry = dict(statuses=[0, 0], paths=['/candidates/0/credentialLabel'])
body = dict(strategy='score', candidates=[dict(credentialLabel={'0': 97}, score=1)])
pair = [dict(code=0, err='', out=json.dumps(body)) for _ in range(2)]
other = copy.deepcopy(body)
other['candidates'][0]['credentialLabel'] = '97'
pair[1]['out'] = json.dumps(other)
assert accepted(pair, entry)
for mutation in ['order', 'extra', 'status', 'stderr', 'score', 'nested-order']:
    p = copy.deepcopy(pair)
    b = copy.deepcopy(other)
    if mutation == 'order': b = dict(reversed(list(b.items())))
    if mutation == 'extra': b['extra'] = 1
    if mutation == 'status': p[1]['code'] = 1
    if mutation == 'stderr': p[1]['err'] = 'error'
    if mutation == 'score': b['candidates'][0]['score'] = 2
    if mutation == 'nested-order': b['candidates'][0] = dict(reversed(list(b['candidates'][0].items())))
    p[1]['out'] = json.dumps(b)
    assert not accepted(p, entry), mutation
print('7 acceptance mutations passed')
