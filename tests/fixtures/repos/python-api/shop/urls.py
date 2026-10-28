"""Django url configuration (fictional test fixture)."""
from django.urls import include, path, re_path

from . import views

PREFIX = "old/"

urlpatterns = [
    path("catalog/", views.catalog, name="catalog"),
    path("catalog/<int:pk>/", views.catalog_detail, name="catalog-detail"),
    re_path(r"^authors/(?P<slug>[\w-]+)/$", views.author, name="author"),
    path("api/", include("shop.api.urls")),
    path(PREFIX + "legacy/", views.legacy),
]
