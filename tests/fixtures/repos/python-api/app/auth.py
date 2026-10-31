"""Token checks for the bookshop API (fictional test fixture)."""


class TokenVerifier:
    def __init__(self, issuer):
        self.issuer = issuer

    def verify(self, token):
        return bool(token)
