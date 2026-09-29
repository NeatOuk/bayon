-- 039_push_url (M8.1): where a repo's delivered work is pushed, when that is not where it is fetched.
--
-- A project created from a local folder records the folder's real path as `repos.origin_url`: the
-- mirror is a bare clone of it, which is right for fetching. 038's delivery then pushed into that
-- same folder — the owner's own checkout — and a path has no forge, so no pull request was opened.
--
--   repos.push_url   NULL (every repo already here): push to origin_url, exactly as before.
--                    Otherwise an https, ssh:// or scp-like URL with no credential in it, read from
--                    the folder's own `origin` when the project was created, or set by the operator.
--
-- No CHECK: the shape rule is core's (checkPushUrl), run by the one writer, and a CHECK would only
-- hold a weaker copy of it. The value never carries userinfo that could be a secret (§14).
ALTER TABLE repos ADD COLUMN push_url TEXT;

-- What a delivery was pushed TO, so a changed target is a change (M8.1 review, HIGH 1). The job skips
-- a repo whose recorded delivery already has this branch's head; without the target in that check,
-- an operator who moves a repo's push_url would see the ticket skipped for ever, on its old remote.
-- The host alone cannot tell two repositories on one forge apart, so this is the whole URL — with
-- its credentials taken out by the writer (core stripPushUrlCredentials), which refuses one that
-- still carries any (§14). NULL on rows written before 039: those went to origin_url.
ALTER TABLE deliveries ADD COLUMN remote_url TEXT;
