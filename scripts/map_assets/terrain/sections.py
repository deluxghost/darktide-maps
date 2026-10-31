"""Project solid collision geometry through a Nav-relative vertical clearance band."""

import numpy as np
import shapely

from .world import curved_shape

AREA_EPSILON = 1e-10
TRIANGLE_EDGES = np.array([[0, 1], [1, 2], [2, 0]])


def edge_intersections(vertices, edges, distances, height):
    ends = distances[edges]
    selected = (ends[:, 0] < height) != (ends[:, 1] < height)
    pair = edges[selected]
    values = ends[selected]
    fraction = (height - values[:, 0]) / (values[:, 1] - values[:, 0])
    return vertices[pair[:, 0]] + (vertices[pair[:, 1]] - vertices[pair[:, 0]]) * fraction[:, None]


def convex_projection(shape, plane, low, high):
    if "curve" in shape:
        center = shape["position"] @ plane[:3] + plane[3]
        extent = shape["radius"] * np.linalg.norm(plane[:3]) + shape["half_height"] * abs(shape["rotation"][:, 0] @ plane[:3])
        if center - extent >= high or center + extent <= low:
            return shapely.Polygon()
        if "vertices" not in shape:
            vertices, edges = curved_shape(*shape["curve"])
            shape["vertices"] = vertices @ shape["rotation"].T + shape["position"]
            shape["edges"] = edges
    points = shape["vertices"]
    distance = points @ plane[:3] + plane[3]
    if distance.min() >= high or distance.max() <= low:
        return shapely.Polygon()
    clipped = [points[(distance >= low) & (distance <= high)]]
    clipped.extend(edge_intersections(points, shape["edges"], distance, height) for height in (low, high))
    return shapely.MultiPoint(np.concatenate(clipped)[:, :2]).convex_hull


def clip_polygon(points, plane, height, above):
    values = points @ plane[:3] + plane[3] - height
    inside = values >= 0 if above else values <= 0
    result = []
    for index in range(len(points)):
        previous = index - 1
        if inside[index] != inside[previous]:
            fraction = values[previous] / (values[previous] - values[index])
            result.append(points[previous] + fraction * (points[index] - points[previous]))
        if inside[index]:
            result.append(points[index])
    return np.array(result).reshape(-1, 3)


def section_caps(triangles, plane, height):
    distances = triangles @ plane[:3] + plane[3] - height
    crossing = (distances.min(axis=1) < 0) & (distances.max(axis=1) > 0)
    faces, values = triangles[crossing], distances[crossing]
    if len(faces) == 0:
        return []
    ends = values[:, TRIANGLE_EDGES]
    selected = (ends[:, :, 0] < 0) != (ends[:, :, 1] < 0)
    if np.any(selected.sum(axis=1) != 2):
        raise ValueError("Invalid collision mesh/plane intersection")
    pairs, ends = faces[:, TRIANGLE_EDGES][selected], ends[selected]
    fraction = -ends[:, 0] / (ends[:, 1] - ends[:, 0])
    points = (pairs[:, 0] + (pairs[:, 1] - pairs[:, 0]) * fraction[:, None]).reshape(-1, 2, 3)
    normals = np.cross(faces[:, 1] - faces[:, 0], faces[:, 2] - faces[:, 0])
    reverse = np.sum((points[:, 1] - points[:, 0]) * np.cross(normals, plane[:3]), axis=1) < 0
    points[reverse] = points[reverse, ::-1]
    segments = points[:, :, :2]
    lines = shapely.linestrings(np.round(segments, 6))
    # Authored triangle meshes may overlap themselves; polygonization requires noded linework.
    linework = shapely.union_all(lines)
    polygons = shapely.get_parts(shapely.polygonize(shapely.get_parts(linework)))
    result = []
    for polygon in polygons:
        point = np.array(polygon.representative_point().coords[0])
        a, b = segments[:, 0] - point, segments[:, 1] - point
        winding = np.arctan2(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0], np.sum(a * b, axis=1)).sum()
        if abs(winding) > np.pi:
            result.append(polygon)
    return result


def surface_projection(shape, plane, low, high, bounds):
    triangles = shape["triangles"]
    if "face_bounds" not in shape:
        shape["face_bounds"] = triangles[:, :, :2].min(axis=1), triangles[:, :, :2].max(axis=1)
    xy_low, xy_high = shape["face_bounds"]
    nearby = np.all(xy_high >= bounds[:2], axis=1) & np.all(xy_low <= bounds[2:], axis=1)
    nearby_triangles = triangles[nearby]
    distance = nearby_triangles @ plane[:3] + plane[3]
    relevant = (distance.min(axis=1) < high) & (distance.max(axis=1) > low)
    polygons = []
    for face in nearby_triangles[relevant]:
        points = clip_polygon(face, plane, low, True)
        if len(points) < 3:
            continue
        points = clip_polygon(points, plane, high, False)
        if len(points) < 3:
            continue
        # A clipped triangle and its XY projection are convex, including near-edge degeneracies.
        polygon = shapely.MultiPoint(points[:, :2]).convex_hull
        if polygon.area > AREA_EPSILON:
            polygons.append(polygon)
    if not shape["surface_only"]:
        # Caps close the solid cross-section; projecting only faces misses vertical walls.
        cache = shape.setdefault("section_caps", {})
        for height in (low, high):
            key = (*plane, height)
            if key not in cache:
                cache[key] = section_caps(triangles, plane, height)
            polygons.extend(cache[key])
    invalid = [shapely.is_valid_reason(polygon) for polygon in polygons if not polygon.is_valid]
    if invalid:
        raise ValueError(f"Invalid collision section {shape['source']}: {invalid}; plane={plane}; bounds={bounds}")
    try:
        return shapely.union_all(polygons)
    except shapely.errors.GEOSException as error:
        raise ValueError(f"Collision section union failed for {shape['source']}; plane={plane.tolist()}; bounds={bounds}; all inputs valid") from error


def project_shape(shape, plane, low, high, bounds):
    if shape["convex"]:
        return convex_projection(shape, plane, low, high)
    return surface_projection(shape, plane, low, high, bounds)
