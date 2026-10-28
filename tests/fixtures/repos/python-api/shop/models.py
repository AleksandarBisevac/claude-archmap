"""Django models (fictional test fixture)."""
from django.db import models


class Publisher(models.Model):
    name = models.CharField(max_length=100)
    country = models.CharField(max_length=2, null=True)


class Edition(models.Model):
    publisher = models.ForeignKey(Publisher, on_delete=models.CASCADE)
    isbn = models.CharField(max_length=13, primary_key=True)
    printed_on = models.DateField()

    class Meta:
        db_table = "editions"
