"""Value tags shared by level overrides and unit dynamic-data trees."""

from enum import IntEnum


class DynamicDataType(IntEnum):
    BOOLEAN = 1
    NUMBER = 2
    STRING = 3
    OBJECT = 0xFFFFFFFF
