require("dotenv").config();
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const ALL_PERMS = {
  perm_approve_content:true, perm_create_users:true, perm_edit_curriculum:true,
  perm_export_data:true, perm_manage_ads:true, perm_manage_geo:true,
  perm_publish_apps:true, perm_replay_analytics:true, perm_upload_unity:true,
  perm_view_analytics:true
};
const ROLE_PERMS = {
  master_admin:    {...ALL_PERMS},
  admin:           {...ALL_PERMS, perm_upload_unity:false},
  education_secretary: {perm_approve_content:true,perm_create_users:false,perm_edit_curriculum:false,perm_export_data:true,perm_manage_ads:false,perm_manage_geo:false,perm_publish_apps:false,perm_replay_analytics:true,perm_upload_unity:false,perm_view_analytics:true},
  dept_education:  {perm_approve_content:false,perm_create_users:false,perm_edit_curriculum:false,perm_export_data:true,perm_manage_ads:false,perm_manage_geo:false,perm_publish_apps:false,perm_replay_analytics:true,perm_upload_unity:false,perm_view_analytics:true},
  district_officer:{perm_approve_content:false,perm_create_users:false,perm_edit_curriculum:false,perm_export_data:true,perm_manage_ads:false,perm_manage_geo:false,perm_publish_apps:false,perm_replay_analytics:false,perm_upload_unity:false,perm_view_analytics:true},
  developer:       {perm_approve_content:false,perm_create_users:false,perm_edit_curriculum:true,perm_export_data:true,perm_manage_ads:false,perm_manage_geo:true,perm_publish_apps:true,perm_replay_analytics:true,perm_upload_unity:true,perm_view_analytics:true},
  data_manager:    {perm_approve_content:false,perm_create_users:false,perm_edit_curriculum:false,perm_export_data:true,perm_manage_ads:false,perm_manage_geo:false,perm_publish_apps:false,perm_replay_analytics:true,perm_upload_unity:false,perm_view_analytics:true},
  view_only:       {perm_approve_content:false,perm_create_users:false,perm_edit_curriculum:false,perm_export_data:false,perm_manage_ads:false,perm_manage_geo:false,perm_publish_apps:false,perm_replay_analytics:false,perm_upload_unity:false,perm_view_analytics:false},
};
(async()=>{
  console.log("Fixing user permissions...\n");
  const snap = await db.collection("users").get();
  if(snap.empty){console.log("No users found.");process.exit(0);}
  const batch = db.batch();
  let count=0;
  snap.forEach(doc=>{
    const u=doc.data(), role=u.role||"view_only";
    const perms=ROLE_PERMS[role]||ROLE_PERMS.view_only;
    const wrong=Object.keys(perms).some(p=>u[p]!==perms[p]);
    if(wrong){
      batch.update(doc.ref,{...perms,updated_at:admin.firestore.FieldValue.serverTimestamp()});
      console.log("  Fixed:",u.email,"("+role+")");
      count++;
    } else {
      console.log("  OK:   ",u.email,"("+role+")");
    }
  });
  if(count>0){await batch.commit();console.log("\nDone — fixed",count,"user(s).");}
  else{console.log("\nAll users already correct.");}
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
