"""Only listed leaves may differ; object order remains observable."""
import copy
import json


def accepted(pair, entry):
    if [p['code'] for p in pair] != entry['statuses'] or pair[0]['err'] != pair[1]['err']:
        return False
    try:
        bodies = [copy.deepcopy(json.loads(p['out'])) for p in pair]
        for root in bodies:
            for path in entry['paths']:
                body = root
                parts = path.strip('/').split('/')
                for key in parts[:-1]:
                    body = body[int(key)] if isinstance(body, list) else body[key]
                body[parts[-1]] = '<accepted-render>'
        return json.dumps(bodies[0], ensure_ascii=False) == json.dumps(bodies[1], ensure_ascii=False)
    except (KeyError, IndexError, TypeError, ValueError):
        return False
