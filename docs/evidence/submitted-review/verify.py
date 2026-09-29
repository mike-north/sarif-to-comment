"""Independent readback check: uses only gh porcelain output and the state files."""
import base64, json, re, struct, sys, os
L = '../../logs/issue-7'
C = '05f323760807c1c30aa7e9efa280d12b8717d7f3'
def load(p): return json.load(open(p))
def dbid(node):
    raw = base64.urlsafe_b64decode(node.split('_', 1)[1] + '==')
    return struct.unpack('>Q', raw[-8:])[0]
reviews = {n: load(f'{L}/readback-pr{n}.json')['reviews'] for n in (33, 34)}
comments34 = re.findall(r'── \[(\d+)\] (\S+):(\d+) \((\S+)\) ──', open(f'{L}/readback-pr34-comments.txt').read())
checks = []
def check(name, ok, detail=''):
    checks.append({'check': name, 'result': 'passed' if ok else 'FAILED', **({'detail': detail} if detail else {})})
def by_id(n, rid):
    return [r for r in reviews[n] if dbid(r['id']) == rid]
cases = [('pr33-draft', 33, 'PENDING', False), ('pr34-submit', 34, 'COMMENTED', True), ('pr34-lost', 34, 'COMMENTED', True)]
for state, pr, want_state, submitted in cases:
    rec = load(f'state/{state}.json')
    rid = rec['receipt']['reviewId']
    found = by_id(pr, rid)
    check(f'{state}: record is completed, receipt names one review on PR #{pr}', rec['phase'] == 'completed' and len(found) == 1)
    r = found[0]
    check(f'{state}: saved request event is {"COMMENT" if submitted else "absent"}', rec['request'].get('event') == ('COMMENT' if submitted else None) and (('event' in rec['request']) == submitted))
    check(f'{state}: GitHub state is {want_state}', r['state'] == want_state, r['state'])
    check(f'{state}: body equals the saved request body byte for byte', r['body'] == rec['request']['body'])
    check(f'{state}: body ends with the record marker, which occurs once', r['body'].endswith('\n\n' + rec['marker']) and r['body'].count(rec['marker']) == 1)
    check(f'{state}: author is the publishing account', r['author']['login'] == 'mike-north')
    check(f'{state}: pinned to the reviewed commit', r['commit']['oid'] == C == rec['request']['commitId'])
    if submitted:
        mine = sorted((int(cid), p, int(line)) for cid, p, line, _ in comments34)
        want = sorted((c['path'], c['line']) for c in rec['request']['comments'])
        check(f'{state}: saved request holds 2 inline comments (lines 4 and 6-7)', want == [('docs/sarif-issue7-fixture.md', 4), ('docs/sarif-issue7-fixture.md', 7)])
check('PR #34 holds exactly two reviews (normal + lost-response publication); no duplicate after retries', len(reviews[34]) == 2)
check('PR #34 lists exactly four inline comments, two per submitted review, on lines 4 and 7', sorted(int(l) for _, _, l, _ in comments34) == [4, 4, 7, 7])
check('PR #33 holds exactly one review: the refused submitted create added nothing', len(reviews[33]) == 1)
rej = load('state/pr33-submit-beside-pending.json')
check('refused submitted create beside a pending draft is recorded as rejected 422 with the event in its saved request', rej['phase'] == 'rejected' and rej['rejection']['status'] == 422 and rej['request'].get('event') == 'COMMENT')
lost = load(f'{L}/live-08-lost-response-pr34.json')
check('lost-response run sent exactly one create request and recovered by marker', lost['createRequests'] == 1 and 'was confirmed on GitHub' in lost['outcome']['markdown'])
json.dump(checks, sys.stdout, indent=2)
print()
sys.exit(0 if all(c['result'] == 'passed' for c in checks) else 1)
