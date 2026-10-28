"""Back-office blueprint (fictional test fixture)."""
from flask import Blueprint, jsonify

admin = Blueprint("admin", __name__, url_prefix="/admin")


@admin.route("/stock", methods=["GET", "POST"])
def stock():
    return jsonify([])


@admin.get("/orders/<int:order_id>")
def order(order_id):
    return jsonify({"id": order_id})


@admin.route("/ping")
def ping():
    return "pong"
