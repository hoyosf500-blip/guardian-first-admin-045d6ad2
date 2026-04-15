import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseServiceKey);

    const { data: keySetting } = await sb.from("app_settings").select("value").eq("key", "dropi_api_key").maybeSingle();
    const apiKey = keySetting?.value || Deno.env.get("DROPI_API_KEY")!;
    const { data: urlSetting } = await sb.from("app_settings").select("value").eq("key", "dropi_store_url").maybeSingle();
    const origin = urlSetting?.value || "https://rushmira.com/";

    // Get a sample order ID from the list
    const today = new Date().toISOString().split("T")[0];
    const params = new URLSearchParams({
      result_number: "1", start: "0",
      date_from: today, date_to: today,
      filter_date_by: "FECHA DE CREADO",
    });

    const listRes = await fetch(`https://api.dropi.co/integrations/orders/myorders?${params}`, {
      headers: { "Content-Type": "application/json", "Accept": "application/json", "dropi-integration-key": apiKey, "Origin": origin },
    });
    const listData = await listRes.json();
    const orderId = listData.objects?.[0]?.id;
    if (!orderId) {
      return new Response(JSON.stringify({ error: "No orders found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fetch single order detail
    const detailRes = await fetch(`https://api.dropi.co/integrations/orders/myorders/${orderId}`, {
      headers: { "Content-Type": "application/json", "Accept": "application/json", "dropi-integration-key": apiKey, "Origin": origin },
    });
    const detailData = await detailRes.json();

    // Check for status history fields
    const order = detailData.objects || detailData.object || detailData;
    const keys = order ? Object.keys(order) : [];

    return new Response(
      JSON.stringify({ orderId, detailKeys: keys, detail: order }, null, 2),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
