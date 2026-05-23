from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class TokenWithOffset:
    offset: Tuple[int, int]
    raw: str
    real_topk: Optional[Tuple[int, float]] = None
    pred_topk: List[Tuple[str, float]] = field(default_factory=list)


@dataclass
class AnalyzeResult:
    model: Optional[str] = None
    bpe_strings: List[TokenWithOffset] = field(default_factory=list)
    error: Optional[str] = None


@dataclass
class AnalyzeRequest:
    model: str
    text: str


@dataclass
class AnalyzeResponse:
    request: AnalyzeRequest
    result: AnalyzeResult


def serialize_analyze_result(result: AnalyzeResult) -> Dict:
    return asdict(result)


def create_empty_analysis_result(error: Optional[str] = None, model: Optional[str] = None) -> Dict:
    result = AnalyzeResult()
    if error:
        result.error = error
    if model:
        result.model = model
    return serialize_analyze_result(result)

