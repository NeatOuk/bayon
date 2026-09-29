-- Reverts 027_project_local_roots: the row goes, and with it every folder it allowed. A reader with
-- no row allows none, so POST /projects takes only a url again -- the safe direction. Projects
-- already created from a folder keep their repo row; their mirror clones from it as before.
DELETE FROM settings WHERE key = 'projects.local_roots';
