"""Demo content: a realistic menu + tables so a new restaurant can try TableTap in one click.

    python seed.py          -> adds the demo menu to the first restaurant
"""
import json

import db
import services as svc

SIZE = [{"name": "Size", "type": "single", "required": True,
         "choices": [{"name": "Regular", "p": 0}, {"name": "Large", "p": 2}]}]

MENU = [
    ("Breakfast", "☕", "Served every morning", ("07:00", "11:30"), [
        ("Full Breakfast", "🍳", 12.5, "Two eggs your way, beef sausage, beans, grilled tomato, toast.",
         ["popular"], ["eggs", "gluten"], [
             {"name": "Eggs", "type": "single", "required": True,
              "choices": [{"name": "Fried", "p": 0}, {"name": "Scrambled", "p": 0}, {"name": "Poached", "p": 0.5}]},
             {"name": "Extras", "type": "multi", "max": 3,
              "choices": [{"name": "Avocado", "p": 2}, {"name": "Halloumi", "p": 2.5}, {"name": "Hash browns", "p": 1.5}]}]),
        ("Pancake Stack", "🥞", 9, "Fluffy buttermilk pancakes, maple syrup, berries.", ["veg"], ["gluten", "dairy", "eggs"], []),
        ("Avocado Toast", "🥑", 10, "Sourdough, smashed avocado, chili flakes, lime, poached egg.", ["veg", "new"], ["gluten", "eggs"], []),
    ]),
    ("Starters", "🥗", "", None, [
        ("Crispy Calamari", "🦑", 9.5, "Lightly fried squid rings, lemon aioli.", ["popular"], ["shellfish", "eggs"], []),
        ("Burrata Salad", "🥗", 11, "Creamy burrata, heirloom tomatoes, basil oil, toasted pine nuts.", ["veg", "chef"], ["dairy", "nuts"], []),
        ("Chicken Wings", "🍗", 10, "Six wings tossed in your favourite sauce.", ["spicy"], ["celery"], [
            {"name": "Sauce", "type": "single", "required": True,
             "choices": [{"name": "Buffalo", "p": 0}, {"name": "BBQ", "p": 0}, {"name": "Honey garlic", "p": 0}]},
            {"name": "Portion", "type": "single", "required": True,
             "choices": [{"name": "6 wings", "p": 0}, {"name": "12 wings", "p": 8}]}]),
        ("Soup of the Day", "🍲", 7, "Ask your server - served with warm bread.", ["veg"], ["gluten"], []),
    ]),
    ("Burgers", "🍔", "All burgers come with fries", None, [
        ("Classic Smash Burger", "🍔", 14, "Double smashed beef patty, cheddar, pickles, house sauce, brioche bun.",
         ["popular"], ["gluten", "dairy", "mustard", "sesame"], [
             {"name": "Cooking", "type": "single", "required": True,
              "choices": [{"name": "Medium", "p": 0}, {"name": "Well done", "p": 0}]},
             {"name": "Add-ons", "type": "multi", "max": 4,
              "choices": [{"name": "Bacon", "p": 2}, {"name": "Fried egg", "p": 1.5}, {"name": "Extra cheese", "p": 1}, {"name": "Jalapeños", "p": 0.5}]},
             {"name": "Side", "type": "single", "required": False,
              "choices": [{"name": "Sweet potato fries", "p": 1.5}, {"name": "Side salad", "p": 0}]}]),
        ("Crispy Chicken Burger", "🍗", 13.5, "Buttermilk fried chicken, slaw, spicy mayo.", ["spicy"], ["gluten", "eggs"], []),
        ("Garden Burger", "🥬", 12.5, "Beetroot & chickpea patty, vegan cheese, tomato, lettuce.", ["vegan"], ["gluten", "soy"], []),
    ]),
    ("Pizza", "🍕", "Stone-baked, 12 inch", None, [
        ("Margherita", "🍕", 11, "San Marzano tomato, fior di latte, basil.", ["veg"], ["gluten", "dairy"], [
            {"name": "Crust", "type": "single", "required": True,
             "choices": [{"name": "Classic", "p": 0}, {"name": "Gluten-free", "p": 2.5}]}]),
        ("Pepperoni", "🍕", 13, "Beef pepperoni, mozzarella, oregano, hot honey.", ["popular", "spicy"], ["gluten", "dairy"], []),
        ("Truffle Mushroom", "🍄", 15, "Wild mushrooms, truffle cream, parmesan, rocket.", ["chef", "veg"], ["gluten", "dairy"], []),
    ]),
    ("Desserts", "🍰", "", None, [
        ("Chocolate Lava Cake", "🍫", 8, "Warm molten centre, vanilla ice cream.", ["popular"], ["gluten", "dairy", "eggs"], []),
        ("Tiramisu", "🍰", 7.5, "Espresso-soaked ladyfingers, mascarpone, cocoa.", [], ["gluten", "dairy", "eggs"], []),
        ("Gelato", "🍨", 6, "Two scoops.", ["veg"], ["dairy"], [
            {"name": "Flavours", "type": "multi", "required": True, "max": 2,
             "choices": [{"name": "Pistachio", "p": 0}, {"name": "Chocolate", "p": 0}, {"name": "Vanilla", "p": 0}, {"name": "Mango sorbet", "p": 0}]}]),
    ]),
    ("Drinks", "🥤", "", None, [
        ("Fresh Orange Juice", "🍊", 4.5, "Squeezed to order.", ["vegan"], [], SIZE),
        ("Mint Lemonade", "🍋", 4, "Lemon, fresh mint, a little sugar, lots of ice.", ["vegan", "popular"], [], SIZE),
        ("Iced Latte", "🧋", 4.5, "Double espresso over milk and ice.", [], ["dairy"], [
            {"name": "Milk", "type": "single", "required": True,
             "choices": [{"name": "Whole", "p": 0}, {"name": "Oat", "p": 0.5}, {"name": "Almond", "p": 0.5}]},
            {"name": "Syrup", "type": "multi", "max": 2,
             "choices": [{"name": "Vanilla", "p": 0.5}, {"name": "Caramel", "p": 0.5}, {"name": "Hazelnut", "p": 0.5}]}]),
        ("Espresso", "☕", 2.5, "", ["vegan"], [], []),
        ("Sparkling Water", "💧", 3, "750 ml bottle.", ["vegan"], [], []),
    ]),
]

TABLES = [("Table %d" % i, "Indoor", 4) for i in range(1, 9)] + [("Terrace %d" % i, "Terrace", 2) for i in range(1, 5)]


def demo_menu(rid, with_tables=True):
    rest = svc.get_restaurant(rid)
    mult = 10 ** rest["decimals"]
    money = lambda x: int(round(x * mult))
    ts = db.now()
    with db.tx() as c:
        base_sort = c.execute("SELECT COALESCE(MAX(sort), -1) + 1 FROM categories WHERE restaurant_id = ?", (rid,)).fetchone()[0]
        for ci, (cname, icon, cdesc, window, items) in enumerate(MENU):
            frm, to = window or ("", "")
            cid = c.execute(
                "INSERT INTO categories(restaurant_id, name, description, icon, available_from, available_to, sort) "
                "VALUES(?,?,?,?,?,?,?)", (rid, cname, cdesc, icon, frm, to, base_sort + ci)).lastrowid
            for ii, (name, emoji, price, desc, tags, allergens, options) in enumerate(items):
                groups = []
                for gdef in options:
                    groups.append({**{k: v for k, v in gdef.items() if k != "choices"},
                                   "choices": [{"name": ch["name"], "price": money(ch["p"])} for ch in gdef["choices"]]})
                c.execute(
                    "INSERT INTO items(restaurant_id, category_id, name, description, price, emoji, tags, allergens, "
                    "options, sort, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (rid, cid, name, desc, money(price), emoji, json.dumps(tags), json.dumps(allergens),
                     json.dumps(svc.normalize_options(groups, rest["decimals"]), ensure_ascii=False), ii, ts, ts))
        if with_tables and not c.execute("SELECT 1 FROM tables WHERE restaurant_id = ?", (rid,)).fetchone():
            for i, (label, zone, seats) in enumerate(TABLES):
                c.execute("INSERT INTO tables(restaurant_id, label, zone, seats, token, sort, created_at) "
                          "VALUES(?,?,?,?,?,?,?)", (rid, label, zone, seats, svc.new_token(9), i, ts))
    c = db.conn()
    c.execute("UPDATE restaurants SET tagline = CASE WHEN tagline = '' THEN ? ELSE tagline END, "
              "wifi_name = CASE WHEN wifi_name = '' THEN ? ELSE wifi_name END WHERE id = ?",
              ("Fresh food, made to order", "Guest-WiFi", rid))


if __name__ == "__main__":
    db.init()
    r = db.q1("SELECT id, name FROM restaurants ORDER BY id LIMIT 1")
    if r is None:
        print("No restaurant yet - open the app and finish setup first.")
    else:
        demo_menu(r["id"])
        print("Demo menu added to %s" % r["name"])
