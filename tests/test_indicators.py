"""Testes matemáticos dos indicadores (valores calculados à mão ou por definição)."""

import math
import random

import pytest

from backend.indicators import core
from backend.indicators.snapshot import InsufficientDataError, compute_snapshot
from backend.market_data.base import Candle


def approx(x, rel=1e-9):
    return pytest.approx(x, rel=rel, abs=1e-9)


def test_sma_by_hand():
    assert core.sma([1, 2, 3, 4, 5], 3) == [None, None, 2.0, 3.0, 4.0]


def test_ema_by_hand():
    # período 3: k = 0,5; semente = média(1,2,3) = 2; depois 4*0,5+2*0,5 = 3; 5*0,5+3*0,5 = 4
    assert core.ema([1, 2, 3, 4, 5], 3) == [None, None, 2.0, 3.0, 4.0]
    assert core.ema([1, 2], 3) == [None, None]


def test_ema_of_constant_series_is_the_constant():
    assert core.ema([7.0] * 30, 10)[-1] == approx(7.0)


def test_rsi_extremes():
    assert core.rsi(list(range(1, 30)))[-1] == 100.0          # só altas
    assert core.rsi(list(range(30, 1, -1)))[-1] == approx(0.0)  # só quedas
    assert core.rsi([5.0] * 30)[-1] == 50.0                    # sem movimento


def test_rsi_by_hand_period_2():
    # variações: +1, -1, +2 -> período 2
    # inicial: ganho médio 0,5; perda média 0,5 -> RSI 50
    # próxima (+2): ganho = (0,5+2)/2 = 1,25; perda = 0,25 -> RS 5 -> RSI 83,333...
    out = core.rsi([10, 11, 10, 12], 2)
    assert out[:2] == [None, None]
    assert out[2] == approx(50.0)
    assert out[3] == approx(100 - 100 / 6)


def test_rsi_matches_independent_wilder_implementation():
    random.seed(7)
    closes = [100.0]
    for _ in range(200):
        closes.append(closes[-1] * (1 + random.uniform(-0.02, 0.02)))
    period = 14
    changes = [b - a for a, b in zip(closes, closes[1:])]
    g = sum(max(c, 0) for c in changes[:period]) / period
    l = sum(max(-c, 0) for c in changes[:period]) / period
    for c in changes[period:]:
        g = (g * 13 + max(c, 0)) / 14
        l = (l * 13 + max(-c, 0)) / 14
    assert core.rsi(closes)[-1] == approx(100 - 100 / (1 + g / l))
    assert all(0 <= v <= 100 for v in core.rsi(closes) if v is not None)


def test_macd_definition_and_alignment():
    closes = [float(i + math.sin(i)) for i in range(80)]
    m = core.macd(closes)
    f, s = core.ema(closes, 12), core.ema(closes, 26)
    assert m["macd"][24] is None and m["macd"][25] == approx(f[25] - s[25])
    assert m["signal"][32] is None and m["signal"][33] is not None  # 26 + 9 - 2
    assert m["signal"][33] == approx(sum(m["macd"][25:34]) / 9)
    assert m["histogram"][-1] == approx(m["macd"][-1] - m["signal"][-1])
    with pytest.raises(ValueError):
        core.macd(closes, fast=26, slow=12)


def test_macd_of_constant_series_is_zero():
    m = core.macd([3.0] * 60)
    assert m["macd"][-1] == approx(0.0) and m["histogram"][-1] == approx(0.0)


def test_bollinger_by_hand():
    b = core.bollinger([2, 4, 4, 4, 5, 5, 7, 9], period=8, k=2)
    # média 5; desvio-padrão populacional 2
    assert b["middle"][-1] == approx(5.0)
    assert b["upper"][-1] == approx(9.0) and b["lower"][-1] == approx(1.0)


def test_atr_by_hand():
    highs, lows, closes = [10, 12, 13, 15], [8, 9, 11, 12], [9, 11, 12, 14]
    # TRs: max(3, 3, 0)=3 ; max(2, 2, 0)=2 ; max(3, 3, 0)=3
    out = core.atr(highs, lows, closes, period=2)
    assert out[2] == approx(2.5)
    assert out[3] == approx((2.5 * 1 + 3) / 2)


def test_vwap_by_hand():
    out = core.vwap([10, 20], [10, 20], [10, 20], [1, 3])
    assert out == [approx(10.0), approx((10 * 1 + 20 * 3) / 4)]
    assert core.vwap([1], [1], [1], [0]) == [None]


def test_ichimoku_by_definition():
    n = 120
    highs = [float(i + 2) for i in range(n)]
    lows = [float(i) for i in range(n)]
    closes = [float(i + 1) for i in range(n)]
    ich = core.ichimoku(highs, lows, closes)
    assert ich["tenkan"] == approx((highs[-1] + lows[-9]) / 2)
    assert ich["kijun"] == approx((highs[-1] + lows[-26]) / 2)
    past = n - 26
    t = (max(highs[past - 9 : past]) + min(lows[past - 9 : past])) / 2
    k = (max(highs[past - 26 : past]) + min(lows[past - 26 : past])) / 2
    assert ich["span_a"] == approx((t + k) / 2)
    assert ich["span_b"] == approx((max(highs[past - 52 : past]) + min(lows[past - 52 : past])) / 2)
    assert core.ichimoku(highs[:40], lows[:40], closes[:40])["span_b"] is None


def test_fibonacci_levels():
    levels = core.fibonacci_levels(200, 100)
    assert levels["0.000"] == 200 and levels["1.000"] == 100
    assert levels["0.618"] == approx(138.2) and levels["0.500"] == approx(150)
    with pytest.raises(ValueError):
        core.fibonacci_levels(1, 2)


def test_pivots_support_resistance_and_structure():
    highs = [1, 2, 3, 9, 3, 2, 1, 2, 3, 12, 3, 2, 1, 2, 3]
    lows = [h - 1 for h in highs]
    tops, bottoms = core.pivots(highs, lows, wing=3)
    assert [i for i, _ in tops] == [3, 9]
    sr = core.support_resistance(highs, lows, price=5, wing=3)
    assert sr["resistance"] == 9 and sr["support"] == 0
    up_h = [1, 2, 5, 2, 3, 7, 4, 5, 9, 6, 7]
    up_l = [0, 1, 4, 1, 2, 6, 3, 4, 8, 5, 6]
    assert core.market_structure(up_h, up_l, wing=1) == "up"
    assert core.market_structure(up_h[::-1], up_l[::-1], wing=1) == "down"
    assert core.market_structure([1, 1, 1], [1, 1, 1]) == "range"


def test_relative_volume():
    assert core.relative_volume([10] * 20 + [30], 20) == approx(3.0)
    assert core.relative_volume([10] * 5, 20) is None


def test_candle_patterns():
    names = lambda *a: [p["name"] for p in core.candle_patterns(*a)]
    assert names([10], [11], [9], [10.05]) == ["doji"]
    assert names([10], [10.6], [8], [10.5]) == ["martelo"]
    assert names([10.5], [12.5], [9.9], [10]) == ["estrela cadente"]
    assert "engolfo de alta" in names([10, 9], [10.2, 10.8], [8.9, 8.8], [9.2, 10.5])
    assert "engolfo de baixa" in names([9, 10], [10.2, 10.3], [8.9, 8.5], [9.8, 8.8])
    assert names([5], [5], [5], [5]) == []


def _candles(n):
    out = []
    for i in range(n):
        base = 100 + i * 0.5 + math.sin(i / 3) * 2
        out.append(Candle(i * 60000, base, base + 1, base - 1, base + 0.3, 10 + i % 5, i * 60000 + 59999, True))
    return out


def test_snapshot_is_complete_and_deterministic():
    candles = _candles(250)
    a, b = compute_snapshot(candles), compute_snapshot(candles)
    assert a == b
    assert a["price"] == candles[-1].close
    for key in ("rsi", "atr", "vwap", "atr_pct", "relative_volume"):
        assert a[key] is not None
    assert a["ema"]["200"] is not None and a["ichimoku"]["span_b"] is not None
    assert a["macd"]["histogram"] is not None


def test_snapshot_marks_missing_data_as_none_and_refuses_too_little():
    snap = compute_snapshot(_candles(40))
    assert snap["ema"]["200"] is None and snap["ema"]["50"] is None
    assert snap["ichimoku"]["span_b"] is None
    with pytest.raises(InsufficientDataError):
        compute_snapshot(_candles(10))
