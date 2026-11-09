"""Display reachable nav with adjacent unstandable fragments, without reshaping triangles.

A fragment has no probe point with player-body clearance. Include fragments connected to reachable regions,
including chains of fragments; leave isolated fragments hidden.
"""

import numpy as np

SPACING = 0.1      # m; probe points inside triangles, the spacing of the clearance edge points


def probe_points(tris):
    """(points, owner): a lattice of points inside each triangle, at most SPACING apart."""
    steps = np.maximum(np.ceil(np.linalg.norm(tris - np.roll(tris, 1, axis=1), axis=2).max(1) / SPACING), 1).astype(int)
    points, owner = [np.zeros((0, 3))], [np.zeros(0, int)]
    for n in np.unique(steps):
        index = np.nonzero(steps == n)[0]
        i, j = np.nonzero(np.add.outer(np.arange(n + 1), np.arange(n + 1)) <= n)
        weights = np.stack([n - i - j, i, j], axis=1) / n
        points.append(np.einsum("kv,tvd->tkd", weights, tris[index]).reshape(-1, 3))
        owner.append(np.repeat(index, len(weights)))
    return np.concatenate(points), np.concatenate(owner)


def displayed(model, reach):
    """Boolean display mask over carved nav triangles."""
    region = model.region
    candidate = np.nonzero(~reach & ~model.unsupported)[0]
    points, owner = probe_points(model.P[candidate])
    fragment = np.zeros(model.region_count, bool)
    fragment[region[candidate]] = True
    fragment[region[candidate[owner[model.clear(points)]]]] = False
    shown = np.zeros(model.region_count, bool)
    shown[region[reach]] = True
    a, b = region[model.adjacent[:, 0]], region[model.adjacent[:, 1]]
    a, b = np.r_[a, b], np.r_[b, a]
    while True:
        grow = np.unique(b[shown[a] & ~shown[b] & fragment[b]])
        if not len(grow):
            return shown[region] & ~model.unsupported
        shown[grow] = True
