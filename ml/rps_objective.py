"""
Ranked probability score as a LightGBM objective, for boosting on top of a reference
distribution (init_score = log reference).

With logits z, p = softmax(z), F_k = sum_{j<=k} p_j and O_k = 1[label <= k] (k = 0..K-2):

    RPS         = 1/(K-1) * sum_k (F_k - O_k)^2
    dF_k/dz_j   = p_j * (1[j<=k] - F_k)
    grad_j      = 2/(K-1) * p_j * (sum_{k>=j} r_k - sum_k r_k F_k)            r = F - O
    hess_j     ~= 2/(K-1) * p_j^2 * (sum_{k>=j} (1-F_k)^2 + sum_{k<j} F_k^2)   (Gauss-Newton)

The Gauss-Newton Hessian is always >= 0, which keeps leaf values stable.
"""
import numpy as np


def softmax(z: np.ndarray) -> np.ndarray:
    e = np.exp(z - z.max(axis=1, keepdims=True))
    return e / e.sum(axis=1, keepdims=True)


def rps_from_probs(probs: np.ndarray, labels: np.ndarray) -> float:
    k = probs.shape[1]
    cum_p = np.cumsum(probs, axis=1)[:, : k - 1]
    cum_o = (labels[:, None] <= np.arange(k - 1)[None, :]).astype(float)
    return float(np.mean(np.sum((cum_p - cum_o) ** 2, axis=1) / (k - 1)))


def rps_grad_hess(z: np.ndarray, labels: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-row gradient and Hessian diagonal of RPS w.r.t. the logits z (n, K)."""
    n, k = z.shape
    p = softmax(z)
    F = np.cumsum(p, axis=1)[:, : k - 1]
    O = (labels[:, None] <= np.arange(k - 1)[None, :]).astype(float)
    r = F - O
    # tail[:, j] = sum_{k>=j} x_k over thresholds k = 0..K-2 (zero for j = K-1).
    def tail(x: np.ndarray) -> np.ndarray:
        t = np.zeros((n, k))
        t[:, : k - 1] = np.cumsum(x[:, ::-1], axis=1)[:, ::-1]
        return t

    def head(x: np.ndarray) -> np.ndarray:
        # head[:, j] = sum_{k<j} x_k
        h = np.zeros((n, k))
        h[:, 1:] = np.cumsum(x, axis=1)
        return h

    scale = 2.0 / (k - 1)
    grad = scale * p * (tail(r) - (r * F).sum(axis=1, keepdims=True))
    hess = scale * p**2 * (tail((1 - F) ** 2) + head(F**2))
    return grad, np.maximum(hess, 1e-9)


def lgb_objective(preds: np.ndarray, data) -> tuple[np.ndarray, np.ndarray]:
    """LightGBM custom objective. `preds` are raw scores (init_score included), shape (n, K)."""
    return rps_grad_hess(preds, data.get_label().astype(np.int64))


def lgb_rps_metric(preds: np.ndarray, data) -> tuple[str, float, bool]:
    return "rps", rps_from_probs(softmax(preds), data.get_label().astype(np.int64)), False
