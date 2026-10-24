def normalize_timeout(seconds: int) -> int:
    """Clamp timeout values to a nonnegative integer."""
    return max(0, seconds)
