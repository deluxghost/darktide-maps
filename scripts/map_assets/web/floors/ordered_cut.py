import json
import sys
from time import perf_counter

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import maximum_flow, breadth_first_order

data = json.load(sys.stdin)
started = perf_counter()
edges = np.asarray(data['edges'], dtype=np.int64)
capacity = csr_matrix((edges[:, 2], (edges[:, 0], edges[:, 1])), shape=(data['size'], data['size']))
if capacity.data.min() <= 0 or capacity.data.max() >= np.iinfo(np.int32).max:
		raise ValueError('Capacity exceeds the solver integer range')
flow = maximum_flow(capacity, data['source'], data['sink'])
residual = capacity - flow.flow
residual.data = (residual.data > 0).astype(np.int64)
residual.eliminate_zeros()
reachable = breadth_first_order(residual, data['source'], directed=True, return_predecessors=False)
json.dump({'reachable': reachable.tolist(), 'flow': int(flow.flow_value), 'solverMs': (perf_counter() - started) * 1000}, sys.stdout)
