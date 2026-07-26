from fastapi import APIRouter, Depends

from app.core.security import CurrentUserDep, get_current_user
from app.deps import RetrieverDep
from app.schemas.search import SearchRequest, SearchResponse

router = APIRouter(tags=["search"], dependencies=[Depends(get_current_user)])


@router.post("/search", response_model=SearchResponse)
def post_search(
    request: SearchRequest, user: CurrentUserDep, retriever: RetrieverDep
) -> SearchResponse:
    results = retriever.retrieve(
        request.query, user_id=str(user.id), top_k=request.top_k, filters=request.filters
    )
    return SearchResponse(results=results)
