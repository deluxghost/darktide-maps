"""Compose game placement transforms in column-vector convention."""

import numpy as np
from scipy.spatial.transform import Rotation


def placement_matrix(placement):
    matrix = np.eye(4)
    matrix[:3, :3] = Rotation.from_quat(placement["rotation"]).as_matrix() @ np.diag(placement["scale"])
    matrix[:3, 3] = placement["position"]
    return matrix
