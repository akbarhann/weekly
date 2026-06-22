/**
 * Google Apps Script Web App for uploading files and organizing them into folders.
 * Deployed as a Web App with access "Anyone" (public, to be called via Discord bot).
 */

function doPost(e) {
  try {
    var JSONdata = JSON.parse(e.postData.contents);
    
    var base64Content = JSONdata.content;
    var filename = JSONdata.filename;
    var parentFolderId = JSONdata.folderId || "1AF7zvgT0fuMTzTrXV_FKwUWj1R7JeOcx";
    var dateRange = JSONdata.dateRange; // e.g. "2026-06-08_to_2026-06-14"
    var platform = JSONdata.platform; // e.g. "GRAB", "SHOPEE", "GRAB_VB", "SHOPEE_VB"
    
    if (!base64Content || !filename) {
      return responseJSON({ status: "error", message: "Missing content or filename" });
    }
    
    var fileBlob = Utilities.newBlob(Utilities.base64Decode(base64Content), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename);
    
    // 1. Get or create parent folder
    var parentFolder = DriveApp.getFolderById(parentFolderId);
    if (!parentFolder) {
      return responseJSON({ status: "error", message: "Parent folder not found" });
    }
    
    var targetFolder = parentFolder;
    
    // 2. Get or create dateRange subfolder
    if (dateRange) {
      var dateFolders = parentFolder.getFoldersByName(dateRange);
      if (dateFolders.hasNext()) {
        targetFolder = dateFolders.next();
      } else {
        targetFolder = parentFolder.createFolder(dateRange);
      }
    }
    
    var dateFolderUrl = targetFolder.getUrl();
    
    // 3. Get or create platform subfolder
    if (platform) {
      var platformFolders = targetFolder.getFoldersByName(platform);
      var platformFolder;
      if (platformFolders.hasNext()) {
        platformFolder = platformFolders.next();
      } else {
        platformFolder = targetFolder.createFolder(platform);
      }
      targetFolder = platformFolder;
    }
    
    // 4. Overwrite or create file
    var existingFiles = targetFolder.getFilesByName(filename);
    while (existingFiles.hasNext()) {
      existingFiles.next().setTrashed(true);
    }
    
    var file = targetFolder.createFile(fileBlob);
    
    return responseJSON({
      status: "success",
      message: "File uploaded successfully",
      fileId: file.getId(),
      url: file.getUrl(),
      folderUrl: dateFolderUrl, // Link to the date range folder
      platformFolderUrl: targetFolder.getUrl() // Link to the specific platform folder
    });
    
  } catch (error) {
    return responseJSON({ status: "error", message: error.toString() });
  }
}

function responseJSON(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
