"""
Checks the RPS objective against finite differences.

    docker run --rm -v "$PWD:/app" -w /app/ml --entrypoint python gfm-trainer test_rps_objective.py
"""
import numpy as np

from rps_objective import rps_from_probs, rps_grad_hess, softmax


def row_rps(z: np.ndarray, label: int) -> float:
    return rps_from_probs(softmax(z[None, :]), np.array([label]))


def test_gradient_matches_finite_differences() -> None:
    rng = np.random.default_rng(0)
    for _ in range(50):
        z = rng.normal(0, 2, size=8)
        label = int(rng.integers(0, 8))
        grad, hess = rps_grad_hess(z[None, :], np.array([label]))
        eps = 1e-6
        num = np.array([(row_rps(z + eps * np.eye(8)[j], label) - row_rps(z - eps * np.eye(8)[j], label)) / (2 * eps) for j in range(8)])
        assert np.allclose(grad[0], num, atol=1e-7), (grad[0], num)
        assert (hess > 0).all()


def test_gauss_newton_hessian_matches_jacobian() -> None:
    rng = np.random.default_rng(1)
    z = rng.normal(0, 1, size=8)
    p = softmax(z[None, :])[0]
    F = np.cumsum(p)[:7]
    J = np.array([[p[j] * ((j <= k) - F[k]) for j in range(8)] for k in range(7)])  # dF_k/dz_j
    expected = 2 / 7 * (J**2).sum(axis=0)
    _, hess = rps_grad_hess(z[None, :], np.array([0]))
    assert np.allclose(hess[0], expected, atol=1e-12)


if __name__ == "__main__":
    test_gradient_matches_finite_differences()
    test_gauss_newton_hessian_matches_jacobian()
    print("rps objective ok")
