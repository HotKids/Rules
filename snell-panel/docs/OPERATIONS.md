# Operations

Node lifecycle is `pending -> installing -> active`, with `failed`, `upgrading`, and `disabled` states. Install verification marks a node installing before server changes; successful register marks it active, while install failure callbacks persist `last_error` for operators.
